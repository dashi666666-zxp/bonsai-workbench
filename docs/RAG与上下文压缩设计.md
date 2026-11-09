# RAG 与上下文压缩设计（v0.3.0）

本文记录 0.3.0 新增的「知识库切片检索 + 引用校验」和「上下文压缩」两套机制：为什么这么做、每一步的判据、参数与边界、以及怎么复跑验证。

## 1. 要解决的问题

| 问题 | 现象 | 对策 |
| --- | --- | --- |
| 幻觉 | 27B 在本地文档类问题上会编细节（版本号、参数名、默认值） | 开跑前检索资料注入 prompt + 答案强制标 `[S#]` + 收尾校验引用，不过关重写一次 |
| 检索发散 | 资料里没有答案时模型换词反复检索，直到撑爆上下文 | 单轮检索预算（4 次 search / 1 次 index），超预算返回「基于已有资料作答或直说资料不足」 |
| 上下文超限 | 长会话超过 `-c` 后请求被拒（HTTP 400），或生成期吃满上下文让 llama.cpp 崩 | 按 `-c` 解析预算，超阈值把前段总结成摘要再发；原始消息不删 |

约束：本机 8GB 显存常驻 27B 已用 7.6/8.15GB，**不能再跑 embedding 模型**（会抢显存且拖慢 decode），所以检索走词法 BM25，而不是向量检索。

## 2. 数据流

```
目录 ──chunk.mjs──> 块[{标题路径, 行号, 文本}] ──store.mjs──> index.json + meta.json
                                                              │
用户问题 ──rag.mjs.retrieve()──> BM25 topK ──ground.mjs──> 【知识库检索资料】块
                                                              │
                        system prompt = 规则 + summaryBlock + 资料块
                                                              │
                       模型作答（必须带 [S#]）── verifyAnswer() ──> 通过/重写一次
```

压缩是同一层的前置动作：`compress.mjs` 在检索前检查历史 token，超阈值就先摘要。

## 3. 切片（`model/rag/chunk.mjs`）

1. **分节**：按 Markdown 标题（`#` 前缀）切节，块的 `heading` 是「父 > 子」路径——这样检索命中时能看出上下文位置。
2. **节内切段**：空行切段；单段超预算时按中英文句末标点（`。！？!?；;…`）切句；仍超则硬切。
3. **打包**：按字符预算（默认 `size=700`）把单元装块，块间回退整单元凑 `overlap=120`（约 17%）重叠，避免答案跨块断义；同节尾部碎块并入上一块（小于 `minSize=200` 时）。
4. **元数据**：`startLine/endLine` 从 1 起算，`id = <相对路径>#<序号>`；纯函数、同输入同输出，便于回归。

## 4. 索引（`model/rag/store.mjs`）

- 存 `<BW_DATA>/rag/index.json`（块 + `df/avgLen` 等 BM25 统计）与 `meta.json`（根目录、时间、参数、文件/块/词数、字节数）。
- 扫描：只收约 40 种文本扩展名；跳过 `node_modules/.git/dist/build/out/.next/.cache` 等；单文件 ≤1.5MB；上限 1500 文件 / 5000 块。
- **增量**：文件 `size+mtimeMs` 未变则复用旧块；分块参数（size/overlap/minSize）变了整体重建。
- 写盘先写临时文件再 rename，避免中断留下半份索引；`loadIndex()` 按 mtime 缓存，重建后自动失效。
- `meta.root` 与当前 `rag.root` 不一致时拒绝检索（防止拿旧目录的索引回答新目录的问题），状态行会标「⚠ 目录已变更」。
- **启动自动建索引（0.7.1）**：`server.mjs` 启动时查 `ragStatus(cfg)`，索引不存在或 `rootChanged` 就同步 `buildRagIndex({cfg})` 一次并打印 `RAG 索引已建：N 文件 / M 块`。本机工作区首建实测 1.3 s / 272 文件 / 5000 块（撞块数上限，`truncated=true`）。

## 5. 检索（`model/rag/search.mjs`）

- BM25：`K1=1.2`、`B=0.75`；标题命中额外 ×1.6；最终分数乘查询覆盖率（`0.6 + 0.4 × 命中词数/查询词数`）。
- 分词（`tokens.mjs`）：英文按 `[a-z0-9_]+`（长度 ≥2），中文按「单字 + 相邻双字」——中文没有空格，双字能补一点短语信息，单字保证召回。
- 输出：默认 `k=6`、总量 ≤5200 字；每条带 `file/heading/startLine/endLine/score`。分数低于 `minScore=0.05` 视为没命中。
- 实测：2 文件 / 57 块 / 10,330 词的索引，中文查询检索耗时 1ms。

## 6. 注入与引用校验（`model/rag.mjs` + `model/agent.mjs`）

- 开跑前取最后一条用户消息（跳过 steer 注入）→ `retrieve()`；成功 emit `rag_retrieved`（含 sources），失败 emit `rag_miss`（带人话 reason：RAG 关闭 / 问题太短 / 索引未建立 / 目录不一致 / 没检索到）。
- system prompt 追加「【知识库检索资料】+【引用规则】」五条：只依据资料、每个结论标 `[S#]`、资料不足直说、**资料已由系统检索好，不要再用 `run_command`/`list_dir`/`search_files` 去文件系统另找答案、也不要重复 `rag_search`**、只有确需写入/外部动作才用其他工具（一次问答应在 2 步内结束）。
- 后两条是生产真机教训：首轮 4790 验证时模型拿到资料仍去 `dir`/`list_dir` 翻工作区，36 步不停（历史涨到 17K 被反复裁剪）；补上这两条后同一问题 **1 步**出答案。
- 收尾 `verifyAnswer(content, chunks, {citeRequired})`：
  - **硬失败**：引用了不存在的编号；有资料且没弃答却零引用。
  - **只告警**：引号摘录与原文对不上（跨行摘录、改写过）。
  - 弃答识别：命中「资料不足 / 资料中没有 / 无法依据资料 / 没有检索到」等表述。
- 硬失败且本轮还没重写过 ⇒ 追加一条「【系统校验】…请只依据【知识库检索资料】重写」的 user 消息重试一次；再失败就放行（记 warning），避免死循环。
- 事件 `rag_verify` 带 `{ok, cites, invalid, abstained, quoteCount, unverified, reasons, warnings}`，UI 显示成 sysline「引用校验通过：S6, S3 / 未通过：…」。

## 7. 检索预算

`model/agent.mjs`：`RAG_SEARCH_BUDGET=4`、`RAG_INDEX_BUDGET=1`，按本轮 run 计数（新一轮重新计）。超预算时工具不执行，直接回 tool 消息要求「基于已有资料作答并标 `[S#]`；资料里没有就直说资料不足并指出缺什么」。

由来（实测）：不设预算时，对一个资料里没有的问题，模型连做 12 次 `rag_search`（还自己调大 k）、3 次 `rag_index`、外加 `run_command find /`，17 步 107s 后把 prompt 顶到 16,778–17,310 token（超过 16,384），llama.cpp 在 15,875 token 时报 `bad allocation` 并触发 `GGML_ASSERT(batch.slot_batched || batch.size() == 0)` 内部崩——不只是 HTTP 400。

## 8. 上下文压缩（`model/compress.mjs`）

- `contextSize(cfg, limit=0)`：优先用 `limit`（0.7.1 起由调用方传入服务端真实 n_ctx——`llamacpp.ctxSize()` 读 `/props` 的 `default_generation_settings.n_ctx`、缓存 30 s；`agent.mjs` 开跑前取一次传给 `compressSession({ctxLimit})`，`api.mjs` 的 state/手动压缩同口径）；`limit` 为 0 时才正则解析 `llamacpp.extraArgs` 的 `-c N`，再不行缺省 8192。`estimateContext()` 用与发送端一致的 token 估算（ASCII 2.8 字符/token、CJK 1 字/token、每图 1100 token）算 `used / budget / ratio`。**修前只读 `-c`**：外部端点下服务端 131072 而工作台按 8192 算 ⇒ 约 4k token 就白跑一次摘要。
- `planCompression()`：`ratio ≥ ctx.ratio`（默认 0.72）、消息数 ≥ `minMessages`（8）、且能找到落在 **user 边界** 的切点才 `should:true`；切点前的消息进摘要、之后保留（默认至少留 `keepRecent=10` 条）。
- `compressSession()`：把待摘要消息渲染成受预算约束的文本（总 ≤`maxSourceChars=14000`），让模型总结成 ≤`summaryChars=1200` 字；成功写 `session.summary / summaryUpTo / summaryAt / summaryMeta`，emit `ctx_compressed {before, after, budget, covered, remaining, summaryChars}`；失败返回 `{ok:false, reason}` 不抛（emit `ctx_info`），本轮继续跑。
- 发送侧：`toLLMMessages()` 从 `summaryUpTo` 起取消息，`summaryBlock()` 作为 system 的一段前置。**原始消息仍留在 `session.messages` 里**，会话文件可回看全文，压缩只影响「这次发什么」。
- 手动：`POST /api/compress {sessionId}` 或设置面板「立即压缩」。

## 9. 参数表（默认值）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `rag.enabled` | true | 关掉则 `rag_search/rag_index` 不注册、不自动检索 |
| `rag.autoRetrieve` | true | 开跑前自动检索 |
| `rag.citeRequired` | true | 要求答案带 `[S#]` |
| `rag.root` | ''（=工作区） | 知识库目录 |
| `rag.topK` | 6 | 注入块数上限（1–20） |
| `rag.maxChars` | 5200 | 注入资料总字数（800–20000） |
| `rag.chunkSize` / `rag.overlap` / `rag.minSize` | 700 / 120 / 200 | 分块参数 |
| `rag.maxFiles` / `rag.maxChunks` / `rag.maxFileBytes` | 1500 / 5000 / 1500000 | 索引上限 |
| `ctx.enabled` | true | 关掉则不做自动压缩 |
| `ctx.ratio` | 0.72 | 触发阈值（历史/budget） |
| `ctx.keepRecent` | 10 | 至少保留的尾部消息数 |
| `ctx.summaryChars` | 1200 | 摘要字数上限 |
| `ctx.maxSourceChars` | 14000 | 送进摘要的原文上限 |
| `ctx.minMessages` | 8 | 少于该条数不压缩 |

## 10. 接口与事件

- `GET /api/rag` → 索引状态 + 参数 + `rootChanged`；`POST /api/rag/index {root?,rebuild?}` → 重建（同步）；`POST /api/rag/search {query}` → `{matched, chars, tookMs, sources, chunks}`。
- `POST /api/compress {sessionId}` → 摘要结果 + 前后估算。
- SSE 新增：`rag_retrieved / rag_miss / rag_verify / ctx_compressed / ctx_info`。UI 把这些 sysline 按会话缓存在 `state.notices`，`run_end` 重渲染后仍可见。

## 11. 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 离线 | `node test/smoke.mjs` | SMOKE PASS 127 / 0（RAG+压缩 33 项） |
| 真机 HTTP | `_scratch/live_rag_probe.mjs`（服务起在 4791、`BW_DATA=_scratch/data_rag`） | LIVE_RAG_PROBE PASS 21 / 0：中文命中带出处、真实 run 出 `rag_retrieved`/`rag_verify` 且答案带 `[S2]`、无依据问题弃答、compress 摘要 913 字覆盖 14 条 |
| 浏览器 | `_scratch/ui_probe_rag.mjs`（无头 Edge + CDP，端口 9362） | UI_RAG_PROBE PASS 24 / 0：设置面板、试检索 `[S1]`+行号、真跑一轮出现「知识库命中 6 条」「引用校验通过：S6, S3」、控制台 0 报错 |
| 生产实例 | `_scratch/prod_verify_4790.mjs`（4790 + `bonsai.config.json`，`rag.root=docs`） | **PROD_VERIFY PASS 14 / 0**（11s）：索引 3 文件 / 75 块、检索命中 61 取 6、真实 run **1 步**结束、答案带 `[S1]` 且 0.72 / 10 / 1200 全对 |

复跑前提：`BW_PORT=4791 BW_DATA=_scratch/data_rag BW_CONFIG=_scratch/data_rag/config.json node server.mjs`，且 llama-server 在 8082；中文查询别用 PowerShell `Invoke-RestMethod`（会把中文变成 `?` 造成假 miss），用 Node fetch 或 UI。

## 12. 已知边界

1. **词法 ≠ 语义**：同义词、跨语言、口语句会漏；改写幅度大的长文档可能检索不到。要语义检索必须引入 embedding 模型，8GB 卡需与 27B 分时（未做）。
2. **引用校验只拦形式**：不判断引用内容是否真的支持结论；断章取义仍可能发生；引文对不上只告警。
3. **摘要是有损的**：同一 27B 生成，多次压缩累积损失；摘要失败退回硬裁（`fitMessages`），可能丢上下文。
4. **同步索引**：大目录首次索引阻塞该次请求；上限 1500 文件 / 5000 块。
5. **预算经验值**：4 次检索可能不够多跳问题，改 `RAG_SEARCH_BUDGET` 需同时看上下文压力。
6. 中文分词是单字+双字，不做词表与停用词学习；极短查询（<2 字）直接不检索。
