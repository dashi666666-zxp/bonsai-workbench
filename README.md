# Bonsai Workbench

一个**只连 llama.cpp / LLMpod** 的本地 agent 工作台。与 `ollama-workbench` 是两条独立的产品线：本应用**不导入、不调用任何 Ollama 接口**，数据目录、端口、桌面入口、配置全部独立。

- 默认地址：<http://127.0.0.1:4790>
- 默认数据目录：`~/.bonsai-workbench`（会话 / 运行记录 / 回执 / 托管日志）
- 默认模型：`llama/bonsai-2-27b`（PrismML 三值量化运行时，见 `bonsai.config.json`）
- 版本：0.7.1（零依赖，Node ESM + MVC；含图片输入多模态、RAG 切片检索与引用校验、上下文压缩、思考路径 PSV、强制回执、会话删除与运行中会话置顶、记忆分层与联网搜索、外部端点 Bearer 鉴权、端点模式一键切换、主界面联网开关；0.7.1 四项开箱修补：**RAG 默认索引整个工作区并在启动时自动建索引**、**压缩阈值改跟服务端真实 n_ctx**、**记忆空库自动提示模型写入**、**技能面板按启用状态分组**）

```
git clone https://github.com/dashi666666-zxp/bonsai-workbench.git
cd bonsai-workbench

# 首次运行：把脱敏样例复制成个人配置（含端点/本机路径，后者不入库）
cp bonsai.config.example.json bonsai.config.json   # Windows: copy bonsai.config.example.json bonsai.config.json

# 启动（或双击 启动Bonsai工作台.bat / 桌面「Bonsai 工作台」快捷方式）
node server.mjs
```

依赖：Node.js ≥ 18；本机托管模式还需要一个能跑 Bonsai 的 llama.cpp 运行时（默认 PrismML 分支，路径写在配置里）。如果只想连远端 LLMpod 网关，把 `llamacpp.autostart` 设为 `false`、`llamacpp.host` 指向网关即可，本机无需安装运行时。

多模态（看图）走同一条 llama.cpp 线：托管模式下把 `llamacpp.mmproj` 指向 mmproj GGUF 就会带上视觉能力；配置留空则纯文本。外部端点模式下视觉由**服务端**决定：本机 8080 的 ada 启动器自 0.7.0 起默认 `BONSAI_MMPROJ` 指向那份 629 MB 视觉塔（CPU 编码、不占显存），挂上后工作台模型条会亮「视觉」，带图 run 实测能答「圆形+红色」。

减少幻觉走 RAG：把一个目录（默认工作区）建成切片索引，每次开跑前自动检索、把带出处的资料块注入 system prompt，答案必须标 `[S#]`，收尾时校验引用——引用了不存在的编号、或有资料却零引用又不肯说「资料不足」，就让它重写一次。长会话另有上下文压缩：历史快过来时先把前段总结成摘要再发请求，原始消息不删（见 §3.10 / §3.11）。

每次 run 还内置一条思考路径：开跑先出「计划」，检索到的资料作「取证」，作答后按「结论 / 依据 / 自检」自检——四个阶段由代码推进，不靠模型自觉；run 结束（完成 / 停止 / 出错 / 中断）一律写回执报告，格式固定为「结论先行 → 做了什么 → 验收证据 → 边界 → 下一步」（见 §3.12 / §3.13）。

---

## 1. 与 Ollama 线的关系

| 维度 | Ollama 工作台（既有） | Bonsai Workbench（本应用） |
| --- | --- | --- |
| 后端 | Ollama `/api/chat` + 可选 llama.cpp | 只有 llama.cpp / OpenAI 兼容 `/v1` |
| 端口 | 4788 | **4790** |
| 数据目录 | `~/.ollama-workbench` | **`~/.bonsai-workbench`** |
| 环境变量前缀 | `OW_*` | **`BW_*`** |
| 模型列表 | Ollama + llama.cpp 并集 | 单端点 `/v1/models` |
| 嵌入 / 记忆 | EmbeddingGemma + 本地向量库 | **无**（本应用不注册 remember/recall） |

旧 Ollama 工作台不受影响、可同时运行；两者不共享任何会话或配置。`test/smoke.mjs` 有一条静态断言：本应用目录下不存在 `model/ollama.mjs`、`model/embeddings.mjs`、`model/hardware.mjs`。

## 2. 架构（MVC）

```
server.mjs               HTTP 服务 + 静态资源 + 路由表（BW_PORT，默认 4790）
controller/
  api.mjs                状态聚合、模型/工具/插件/技能/MCP/回执、会话与配置
  runs.mjs               run 生命周期（单飞、审批、steer、durable、插件钩子）
  events.mjs             SSE 事件总线（广播 run 事件，刷新/重连不断流）
  router.mjs             极简路由器（method + /path/:param）
  static.mjs             view/ 静态资源与 MIME
model/
  agent.mjs              agent 主循环：llama-only，流式事件、两层工具调用解析
  llm.mjs                唯一模型客户端（包装 llamacpp.mjs，不碰 Ollama）
  llamacpp.mjs           OpenAI 兼容客户端 + llama-server 管理（托管进程 / 外部端点 Bearer）
  tools.mjs              内置工具 + MCP/插件/技能/子 agent 工具注册与执行
  agents.mjs             子智能体运行时（spawn/message/status，可 steer）
  config.mjs             默认配置、深合并、BW_DATA / BW_CONFIG / BW_RECEIPT_DIR
  store.mjs              会话持久化（sessions/）
  durable.mjs            durable run 记录与事件流（runs/*.json|jsonl，重启标 interrupted）
  compress.mjs           上下文压缩（滚动摘要 + 保留最近 N 条，切点落 user 边界）
  memory.mjs             分层记忆（user/memory/key 注入，project/daily 按需检索）
  rag.mjs                RAG 门面（检索 + 注入 + 引用校验）
  rag/                   切片 chunk / 索引 store / BM25 search / 引用 ground / tokens
  search.mjs             联网搜索（Bing/DuckDuckGo HTML，sticky 后端 + 5 分钟缓存）
  plugins.mjs            插件加载（tools + hooks）
  skills.mjs             技能目录扫描与逐条开关
  mcp.mjs                MCP 客户端：stdio / Streamable HTTP / SSE
  permission.mjs         三档权限与审批判定
  parser.mjs             原生 tool_calls 与文本 JSON 两层解析
  thinking.mjs           思考路径 PSV（计划生成与解析、确定性兜底计划、答案自检）
  receipt.mjs            内置回执（事件归纳、md/json 生成与落盘、中断补齐）
view/
  index.html / style.css / app.js      单页控制台（无框架、无外链资源）
examples/plugins/        receipt-writer（回执钩子）、demo-tools（示例）
test/                    smoke（离线 209 项）、live、mcp-live、fake MCP 服务器
启动Bonsai工作台.bat      带端口幂等检查的启动器（BW_PORT / BW_CONFIG / BW_OPEN）
bonsai.config.json       本机应用配置（PrismML 路径、-c 32768、-np 1 等）
```

## 3. 功能

### 3.1 端点：托管 / 远端 / 带鉴权的外部端点

- 托管模式：`llamacpp.serverPath` / `modelPath` / `cudartPath` 指向本机二进制与 GGUF，`autostart: true` 时应用启动自动拉起 `llama-server`；右栏「启动端点 / 停止端点」可手动控制，接口 `/api/llamacpp/{status,start,stop}`。
- 远端模式：`host` 指向任意 OpenAI 兼容端点（LLMpod 网关、另一台机器上的 `llama-server`），`autostart: false`，应用不管理进程。
- **鉴权（v0.6.0）**：端点要 `Authorization: Bearer` 时给 `llamacpp.apiKey`（直接写值）或 `llamacpp.apiKeyFile`（指向 key 文件，按 mtime 缓存 ⇒ 服务端换 key 不用重启工作台）。`/v1/models`、`/props`、`/v1/chat/completions` 三处都带同一头；两个都空就不带头（无鉴权端点照旧）。
- **本机当前拓扑（2026-11-08 起）**：连 `D:\llm\ada` 部署的 **ada llama-server**（`http://127.0.0.1:8080`，模型 `bonsai-2-27b`，131,072 上下文 + MTP 投机解码 + tiered KV + mmproj 视觉塔），`apiKeyFile` 指向 `D:\llm\ada\repo\artifacts\api_key.txt`，`autostart:false` 且 `serverPath/modelPath/mmproj/cudartPath/extraArgs` 全清空 ⇒ 工作台只连、不拉进程。
  为什么不用本机托管：同一张 8 GB 卡上再拉一个 llama-server 连 context 都建不起来（`E cmn common_init_: failed to create context`），权重显存与 8080 抢 ⇒ 实测把 8080 服务挤到 `CUDA error: out of memory` 崩掉。
- **端点模式一键切换（0.7.0）**：两种模式只是两组预设字段（`llamacpp.profiles.external` / `.managed`），设置面板「端点模式 → 应用模式」或 `POST /api/llamacpp/mode {mode}` 一键切换；切到 external 会先停掉工作台自己拉起的进程，切到 managed 会立刻尝试拉起并等端点就绪。返回 `{ok, mode, up, reason, status}`：`ok` 只表示模式已切过去并落盘，端点当下通不通看 `up/reason`（切 external 时 ada 没起不算切换失败）。回托管前仍须先停 8080（单卡只能有一个 llama-server）；本机实测「停 ada → 切 managed 4.6 s 拉起 8082 → 真跑对话 → 切回 external 进程退出」全过。
- **本机托管/远端两种老口径仍可手改**：直接编辑配置里的 `host / autostart / serverPath / modelPath / cudartPath / extraArgs` 等价（一键切换只是把预设写进去）。
- 启动顺序：先 `D:\llm\ada\start-bonsai.cmd`（冷启动 13 s 到 listening）→ 再开工作台；8080 掉线时该行显示「端点离线」，每次请求会重探、服务恢复即自动接上（无需重启工作台）。
- `-np 1` 是单槽参数：llama.cpp 默认 4 槽并发会让 prefill 掉到 20+ tok/s，单客户端场景必须串行（详见 §8）。远端端点由服务端自己决定槽数（ada 服务是 `n_slots=1`）。
- `llamacpp.mmproj` 非空（仅托管模式生效）时启动参数自动追加 `--mmproj <文件> --no-mmproj-offload`：视觉塔（629MB）留在 CPU、不占显存，8GB 卡上 `-c 32768` 的纯文本显存零回归（实测 7,685/8,151 MiB）。**外部端点模式下工作台自己不加载 mmproj**，视觉能力取决于服务端是否带 `--mmproj`；本机 ada 启动器已在 `start-bonsai.cmd` 里默认导出 `BONSAI_MMPROJ`（清空该变量即可关视觉），`/props` 实测 `modalities.vision=true`、模型条显示「视觉」。
- 托管日志：`<BW_DATA>/llama-server.log`。

### 3.2 模型能力

模型下拉只列当前端点的 `/v1/models`。每项显示 `显示名 · ctx · 工具 · 视觉`：上下文来自 `/props` 的 `default_generation_settings.n_ctx`，是否带工具取决于 `chat_template` 是否含 tools，视觉标记来自 `/props` 的 `modalities.vision`（即是否加载了 mmproj）；内部模型名统一加 `llama/` 前缀（UI 显示时去掉）。

### 3.2.1 多模态（图片输入，0.2.0 新增）

三个入口：composer 左侧「＋图」按钮、直接把图片粘贴进输入框、把图片拖到 composer 上（拖入时 composer 描红）。最多 4 张。

- 前端压缩：`downscaleImage()` 用 canvas 把最长边压到 **1280**、JPEG 质量 0.86，再转 data URL；单张上限 3,000,000 字符；服务端另设 3,500,000 字符与 `data:image/(png|jpeg|webp);base64` 白名单、最多 4 张。
- 后端体例：user 消息以 `images: [dataURL…]` 存储；`toOpenAIMessages` 拼成 OpenAI content 数组 `[{type:'text'},{type:'image_url',image_url:{url}}]`；纯图不配文字时文本位填「（见图片）」。
- 上下文账：每张图按 **1100 token** 计入裁剪预算；历史超限时先丢图再截文本（日志「已截断 user 提示（图片已丢弃）」），工具轮配对不被拆散。
- 运行中带图发送会被拒绝（提示只用文字追加要求），避免 steer 语义歧义。

### 3.3 对话与运行面板

- SSE 事件流：`run_start / step / delta(thinking|content) / calls / usage / assistant_done / tool_start / tool_end / approval_request / steer_applied / run_end`。
- 右栏实时显示：端点状态、模型、ctx、启动参数、pid、步数、输入/输出 token、tok/s、**首字 · 首答 · 总**耗时、工具流水。
- 思考内容折叠显示，不混进回答正文；运行中继续发送 = 追加要求（steer，不打断当前步）。
- `durable` 打开时运行记录落 `runs/`，中断后可续跑；`/api/runs/:id/{stop,resume,steer,approve,events}`。
- **会话删除（0.5.0）**：会话行右侧 `×` → 确认 → `DELETE /api/sessions/:id`。删的是当前会话就回到空态；删完不影响同 id 的历史 run/回执（它们按 runId 独立落盘）。**正在跑的会话不给删**：按钮置灰，服务端也回 409（运行中的 run 结束后会把 session 写回来，先删等于删不掉）。
- **运行中会话置顶（0.5.0）**：左栏次序 = 运行中的会话 → 其余按最近更新；运行中的行带「运行中」徽标与红色左条。服务端的 `listSessions()` 只按 `updatedAt` 排，而运行中的会话在跑完前不会刷新 `updatedAt`，所以置顶在前端按 `state.runs` 重排。刷新/重连后默认打开的就是这个在跑的会话。

### 3.4 工具（15 个默认）

内置：`list_dir / read_file / write_file / edit_file / search_files / run_command / web_fetch / web_search / rag_search / rag_index / memory`；另有子 agent、技能、插件、MCP 工具按配置动态加入。工具执行前过 `permission.mjs`：三档权限（`read-only` / `workspace-write` / `danger-full-access`）+ 审批策略（`auto` / `ask` / `never`）；`write_file`、`edit_file`、`run_command`、`rag_index`、`memory`、插件/MCP 工具都属于高风险，只读档直接拒绝。

### 3.5 MCP

三种传输：stdio（`command/args/env`）、Streamable HTTP（`type:"http"`）、旧式 SSE（`type:"sse"`）；`${ENV}` 在 url/headers/env 里按进程环境展开。设置面板里粘贴 JSON 即可，`保存` 后自动重连；`/api/mcp/refresh` 手动刷新。

### 3.6 插件与 runEnd 钩子

插件目录 `<BW_DATA>/plugins/<name>/{plugin.json,index.mjs}`，契约：

```js
export const hooks = { async runEnd(ctx) { /* ctx: runId, sessionId, task, status, error, startedAt, endedAt, model, events, session, cfg, dataDir */ } };
export const tools = [{ name, description, parameters, risk, run(args, ctx) }];
export function init({ cfg, pluginDir, dataDir }) {}
```

`runEnd` 在 `run_end` 广播之后触发，串行执行；单个插件抛错只记 `hookErrors`，不影响 run 终态。工具名统一 `plugin__<插件>__<工具>`，风险强制为 `exec`。示例 `examples/plugins/receipt-writer/` 已装在本机数据目录，负责自动回执。

### 3.7 技能

扫描 `~/.agents/skills` 与 `~/.dsh/skills`（可用 `BW_SKILLS` 覆盖），默认全开，可在 UI 里逐条开关；`BW_SKILL_STATE` 记录禁用列表。当前机器扫描到 194 条（启用 6 条）。

面板（0.7.1 起）按启用状态分组：顶部一行 `技能 194 条，已启用 6 条`，**已启用的平铺在前**；其余收进折叠区（`其余 188 条未启用（展开看 / 启用）`），展开后每行显示「字符数 · 来源目录名」与启停按钮，带 `error` 的条目直接标注错误。这样默认视图只占几行，不再被 194 条淹没。

### 3.8 回执

每次 run 结束都会写回执（0.4.0 起由 `model/receipt.mjs` 内置生成，不再依赖插件）：

- `<BW_DATA>/receipts/<runId>.md`：标题 + **结论先行**（✅ 完成 / ⏹ 已停止 / ⚠ 已中断 / ❌ 出错）+ 元信息表（运行 ID / 会话 / 状态 / 任务 / 模型权限 / 时间 / 性能 / 步数工具 / token）+ `## 结论` `## 做了什么` `## 验收证据` `## 触及文件` `## 边界与未验证` `## 下一步`。
- `<BW_DATA>/receipts/<runId>.json`：同内容结构化版本（status / plan / toolCalls / files / usage / receipt 版本等），便于机器读。

右栏「回执」列表可点开预览；接口 `GET /api/receipts`（列表）与 `GET /api/receipts?name=<file>.md|json`（内容，文件名白名单防穿越）。启动时会把上次进程遗留的 `running` 记录补写成「⚠ 已中断」回执。旧的 `receipt-writer` 插件仍可装，但写同名文件会被内置回执覆盖（内置格式为权威）。

### 3.9 设置面板

**端点模式下拉 + 「应用模式」（一键切换）**、端点 host、是否托管、三个本机路径（含 **mmproj**）、额外启动参数、工作区、权限、审批、最大步数、temperature、能力开关、搜索后端（auto/bing/duckduckgo）、RAG（知识库目录 / 三个开关 / topK / 字数上限 / 分块大小 / 重叠 / 试检索 / 重建索引）、上下文压缩（开关 / 触发比例 / 保留条数 / 摘要字数 / 立即压缩）、记忆分层（开关 / 每日日志 / 注入上限 / 状态行 / 查看记忆）、MCP 配置、插件/技能开关、配置来源路径。保存走 `PATCH /api/config`（深合并；`mcpServers` 整体替换）。

### 3.10 RAG 切片检索（0.3.0）

知识库 = 一个目录（配置 `rag.root` 留空时**跟随当前工作区**，设置面板可改），索引落在 `<BW_DATA>/rag/{index,meta}.json`。

- **开箱即用（0.7.1）**：默认索引整个工作区，并在**服务启动时自动检查**——索引不存在、或工作区根变了，就重建一次（本机工作区首建实测 **1.3 s / 272 文件 / 5000 块**，启动屏会打印 `RAG 索引已建：…`）。换工作区不需要手配；`rag.enabled=false` 可整体关掉。

- **切分**（`model/rag/chunk.mjs`）：先按 Markdown 标题分节，节内按空行切段，超长按中英文句末标点切句、再硬切；按字符预算打包成块，块间回退整单元凑 10–20% 重叠；每块带「标题路径 + 起止行号」，纯函数、同输入同输出。
- **索引**（`model/rag/store.mjs`）：只收约 40 种文本扩展名，跳过 `node_modules/.git/dist/build` 等；单文件 ≤1.5MB、最多 1500 文件 / 5000 块；文件 `size+mtimeMs` 未变则复用旧块（增量），分块参数变了整体重建；写临时文件再 rename，避免半份索引。
- **检索**（`model/rag/search.mjs`）：BM25（`K1=1.2`、`B=0.75`，标题命中加权 1.6）+ 查询覆盖率乘子；中文按「单字 + 相邻双字」切词，英文按词。默认 topK=6、注入总量 ≤5200 字。**不用 embedding**：27B 常驻已占 7.6/8.15GB 显存，再跑 embedding 模型会抢显存。
- **注入与校验**（`model/rag.mjs` + `model/agent.mjs`）：每个 run 开跑前用最后一条用户消息自动检索，把「【知识库检索资料】/【引用规则】」注入 system prompt；答案必须带 `[S#]`；收尾 `verifyAnswer()` 只判两类硬失败——引用了不存在的编号、或有资料却零引用且没弃答 ⇒ 追加一条「请只依据资料重写」的系统消息重试一次；引号摘录对不上原文只记 warning 不拦。
- **预算**：单轮最多 4 次 `rag_search`、1 次 `rag_index`，超出直接回错误并提示「基于已有资料作答或直说资料不足」——实测不设限时模型会换词狂检索，把 16K 上下文撑爆并让 llama.cpp server 内部崩（`bad allocation`）。
- **工具与接口**：`rag_search {query,k}`（read 风险）、`rag_index {root,rebuild}`（exec 风险）；`GET /api/rag`、`POST /api/rag/{index,search}`。

### 3.11 上下文压缩（0.3.0）

- **压缩阈值（0.7.1 修）**：上下文大小优先取**服务端真实 n_ctx**（`/props` 的 `default_generation_settings.n_ctx`，缓存 30 s），取不到才退回 `llamacpp.extraArgs` 的 `-c`，再不行缺省 8192；再按 `ctx.ratio`（默认 0.72）算阈值。历史估算超阈值、且能切出 ≥8 条消息、切点落在 user 边界时才触发。**修前只读 `-c`**：外部端点下服务端 131072 而工作台按 8192 算 ⇒ 约 4k token 就触发一次 27B 摘要调用，纯浪费；修后同一份 7,400 token 历史在 `ratio=0.5` 下阈值 65,536、不触发。
- 压缩 = 让模型把「将被裁掉的前段」总结成 ≤`summaryChars`（默认 1200）字的摘要，写进会话的 `summary / summaryUpTo / summaryAt`；**原始消息一条不删**，只是发请求时从 `summaryUpTo` 之后取、摘要作为 system 前置段。会话文件仍可回看全文。
- 失败不阻断：摘要调用出错只 emit `ctx_info`，本轮照常跑（`fitMessages` 仍会硬裁）。
- 手动触发：设置面板「立即压缩」或 `POST /api/compress {sessionId}`；状态行显示上下文 tok / 触发比例 / 保留条数 / 摘要上限。

### 3.12 思考路径 PSV（0.4.0）

一条路径四个阶段，**顺序与阶段切换由代码掌控**（参考 12-factor-agents 的 "Own your control flow"、Plan-and-Solve、Chain-of-Verification）：

1. **计划**：开跑前先用一次小请求让模型产出 2–5 步编号计划（`max_tokens=planMaxTokens`（默认 180）、`think=false`、30s 超时）；调用失败或解析不出步骤就退回**确定性兜底计划**（有资料：读资料 → 标 [S#] 作答 → 自检；无资料：确认目标 → 工具取证 → 作答自检）。计划文本注入 system prompt 的【本轮计划】段。
2. **取证**：即已有的 RAG 检索（自动把资料块与引用规则注入）。
3. **作答**：模型正常作答/调工具，答案要求「结论 / 依据 [S#] / 自检」三段结构。
4. **自检**：收尾检查答复是否含结论、依据、自检段；`thinking.requireSelfCheck=true` 时缺段会追加一条系统校验消息重写一次（默认 `false`，只 emit 事件与写回执，不拦）。

事件：`thinking_stage {stage:'plan',status}`、`thinking_plan {steps,source:'llm'|'fallback',ms}`、`thinking_verify {ok,hasConclusion,hasBasis,hasSelfCheck,missing}`；UI 在对话流里以系统提示行显示，run 结束后仍可见。关闭：`thinking.enabled=false`；只关规划调用：`thinking.planCall=false`（保留 thinking 块规则）。

### 3.13 强制回执（0.4.0）

- 触发点：`controller/runs.mjs` 的 `executeRun` —— **正常结束**（runLoop 末尾、插件钩子之后）与 **异常路径**（catch 里置 error 并落盘会话/durable 之后）都会调 `finishReceipt(run)`；`finally` 负责 10 分钟后的运行记录回收。
- 幂等：`run.receipt` 已存在则跳过；`receipt.enabled=false` 可整体关闭。
- 失败兜底：回执生成自身抛错时写一份最小 md（runId / 状态 / 错误）并 emit `receipt`（error）。
- 中断补齐：进程启动时 `initRuns()` 对上次遗留的 running 记录调 `writeInterruptedReceipts()` 补写成「⚠ 已中断」，已有 md 的跳过。
- 写盘：临时文件 + rename；文件名严格取 runId，非法 runId 落成 `run-<base36>`（防路径穿越）。
- 事件：`receipt {runId,md,json,bytes,statusText}`，UI 显示「回执已生成（N B）」。
- 口径：**回执内容自动生成、不靠模型自觉**；模型只贡献任务、计划与答复，回执里的步数/工具/耗时/引用/文件全部来自 run 事件。

### 3.14 生成速度与调优（0.5.1）

- **本机真值**：首次生成 decode **33–41 tok/s**、prefill 约 **600 tok/s**（4514 token 提示约 7.5 s）；`-c 32768 -ctk/ctv q8_0 -fa on -np 1` 占显存约 7.6–7.7 GB（0.6.0 起上下文翻倍）。
- **跑不完是带宽**：每 token 要读 5.95 GB 权重，实测 25.7 ms/token ⇒ 有效带宽约 231 GB/s（该卡通道上限约 340 GB/s，理论 ≈57 tok/s）。GPU 跑在 2790–2805 MHz（上限 3090）、62–69 °C、97 W、util 98–99% ⇒ 没有降频、没有参数空间。
- **投机解码默认关**：`--spec-type ngram-mod` 在 4 组真实 agent 提示的首轮 `draft_n` 全为 0、tg 变化 ±2%、输出逐字一致；同一 prompt 连打第 2/3 次暴涨（+217%/+689%）是命中上一轮自己生成文本的**基准假象**。只在重复/复述型负载（长文档改写、结构化重复）有收益，需要时手改 `llamacpp.extraArgs` 追加该参数。
- **基准工具**：`npm run bench`（`test/bench.mjs`）对已运行的服务打 4 个固定提示 × N 轮，分别报 `pp1 / tg1 / tg2 / tg3 / drafts`，重复轮明显更快时打印「=缓存命中，非参数收益」；`--json <path>` 可落盘对比。**跨时段基线会漂 20%+，只有同批连跑才可比**。
- 完整数据、11 个变体的结论表与「不要试」清单见 `docs/性能调优.md`。

### 3.15 记忆分层与联网搜索（0.6.0）

**记忆分层**（`model/memory.mjs`）：五是本地纯文本层，无向量库、无 embedding（8GB 卡塞不下第二个模型）。

| target | 文件 | 自动注入 | 用途 |
| --- | --- | --- | --- |
| `user` | `memory/user.md` | ✅ | 用户长期偏好 |
| `memory` | `memory/memory.md` | ✅ | 全局环境事实 |
| `key` | `memory/key/<slug>.md` | ✅ | 当前工作区的关键结论 |
| `project` | `memory/project/<slug>.md` | ❌ | 项目日志 |
| `daily` | `memory/daily/YYYY-MM-DD.md` | ❌ | 每日 run 摘要（自动写、30 天清） |

- 条目单行 `- [YYYY-MM-DD HH:MM] 文本`，单条 ≤2000 字、每层 ≤400 条；`<slug>` = 目录名 + 绝对路径 sha1 前 8 位，跨工作区不串。
- 注入只含 user/memory/key，逐层上限 500/700/900 字符、总 2200（`memory.injectMaxChars`）；**记忆全空则一个字不花**。
- **空库提示（0.7.1）**：三层都空时，system prompt 末尾追加一行「记忆库还空着：本轮若出现长期有用的事实——用户偏好、环境真值、本项目关键结论——用 memory 工具写入 user/memory/key 层，下一轮会自动注入；一次性细节不写」。这一行解决的是「机制在、没人喂」——模型不会自己想到调 `memory`。实测空库跑一轮「记住 4790 端口」：模型自调 `memory` 写入全局层，`/api/state.memory.injectChars` **0 → 172**；有记忆后提示自动消失，`memory.enabled=false` 时也不加。
- 工具 `memory`（`add|list|search|remove`，`risk:'write'`）；`remove` 要求 `match` 唯一命中，多条直接报错不误删；记忆关闭时工具明确报错。
- 每个 run 结束自动追加每日日志：`<任务前 80 字> → done|error|stopped（N 步，X s，r_xxx）`，失败不影响 run。
- `GET /api/memory` 给五层快照；`/api/state.memory` 给轻量摘要；设置面板有「记忆分层」段与「查看记忆」。

**联网搜索**（`model/search.mjs`）：`webSearchEngine: auto|bing|duckduckgo`。`auto` 先试上次成功的引擎（sticky）、DDG 只给 6 s 短超时（本机 DDG 必超时，只有 Bing 通），同一 query+count 5 分钟内走进程内缓存（32 条封顶）并在 `formatResults` 标「（缓存）」。DDG→DDG API→Bing 三级回落与 `unwrapBing` 跳转解析沿用。

**主界面开关（0.7.0）**：顶栏「思考／联网／权限」一排是常用开关，`#websearch` 与设置面板「联网搜索」同源（同一个 `webSearch` 键，勾选即 `PATCH /api/config`，失败回滚勾选）；关掉后 `web_search` 工具从工具列表消失（15→14），模型不会再调它。设置面板里另有「搜索后端」下拉。

设计、边界与复跑见 `docs/记忆分层与联网搜索.md`。

## 4. 配置

优先级：环境变量 > `bonsai.config.json` / `BW_CONFIG` 指向的文件 > 内置默认。

| 键 / 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `BW_PORT` | 4790 | HTTP 端口 |
| `BW_HOST` | 127.0.0.1 | 监听地址 |
| `BW_DATA` | `~/.bonsai-workbench` | 数据根（sessions / runs / receipts / plugins / 日志） |
| `BW_CONFIG` | `bonsai.config.json`（启动器设置） | 配置文件路径；不设时用 `<BW_DATA>/config.json` |
| `BW_RECEIPT_DIR` | `<BW_DATA>/receipts` | 回执目录 |
| `BW_PLUGINS` / `BW_PLUGIN_STATE` | `<BW_DATA>/plugins` / `plugin-toggles.json` | 插件目录与开关 |
| `BW_SKILLS` / `BW_SKILL_STATE` | `~/.agents/skills,~/.dsh/skills` / `skills-state.json` | 技能目录与开关 |
| `BW_MEMORY_DIR` | `<BW_DATA>/memory` | 记忆分层目录（测试隔离用） |
| `BW_OPEN` | 0 | 启动后自动打开浏览器 |
| `BW_NO_LLAMA` | 0 | 禁止自动拉起本机 llama-server |

`bonsai.config.json` 主要字段：`model`、`think`、`permission`、`approval`、`workspace`、`maxSteps`、`temperature`、`llamacpp.{host,autostart,serverPath,modelPath,cudartPath,mmproj,extraArgs,alias,startTimeoutMs,apiKey,apiKeyFile}`、`mcpServers`、`pluginsEnabled`、`skillsEnabled`、`webSearch`、`webSearchCount`、`webSearchEngine`、`rag.*`、`ctx.*`、`thinking.*`、`memory.*`、`receipt.*`。本机当前值（2026-11-08 起＝外部端点模式）：`host:"http://127.0.0.1:8080"`、`autostart:false`、`apiKeyFile:"D:\\llm\\ada\\repo\\artifacts\\api_key.txt"`、`serverPath/modelPath/mmproj/cudartPath/extraArgs` 全空、`alias:"bonsai-2-27b"`、`think:true`、`ctx.summaryChars:1200`、`webSearchEngine:"auto"`、`memory` 全开。上下文与启动参数由 ada 服务决定（`-c 131072`、`q3_0` K/V、tiered KV、MTP draft 1）；旧的托管值 `-c 32768 -np 1` + mmproj 见 §9 历史与 `D:\llm\ada\logs\deploy-log.md`。压缩阈值跟服务端实时 n_ctx 走（0.7.1 起，本机 `/api/state.ctx.contextSize` = **131072**，不再是配置里的 8192）。

`rag` / `ctx` 两段的默认值（见 `model/config.mjs` 的 `DEFAULTS`）：`rag.{enabled,autoRetrieve,citeRequired,root,topK,maxChars,chunkSize,overlap,minSize,maxFiles,maxChunks,maxFileBytes,include}`，`root` 留空=工作区；`ctx.{enabled,ratio,keepRecent,summaryChars,maxSourceChars,minMessages}`；`thinking.{enabled,planCall,maxPlanSteps,planMaxTokens,planTimeoutMs,requireSelfCheck}`（默认全开规划、单轮只多一次小请求、`requireSelfCheck:false` 只提示不拦）；`memory.{enabled,injectMaxChars,userMaxChars,memoryMaxChars,keyMaxChars,daily,injectProject}`（`injectProject` 预留，当前不注入 project 层）；`receipt.{enabled}`（默认 true）。索引、摘要、记忆、回执产物都在 `<BW_DATA>` 下，不进配置。

## 5. HTTP API

```
GET  /api/health                 {ok, app}
GET  /api/state                  version/cfg/models/loaded/llama/runtime/current/sessions/runs/toolCount/mcp/plugins/skills/receipts
GET  /api/models                 POST /api/models/refresh
GET  /api/config                 PATCH /api/config
GET/POST /api/sessions           GET/PATCH/DELETE /api/sessions/:id
POST /api/runs                   GET /api/runs/recent
POST /api/runs/:id/{stop,resume,steer,approve}   GET /api/runs/:id/events
GET  /api/agents                 POST /api/agents/:id/message
GET  /api/mcp                    POST /api/mcp/refresh
GET  /api/plugins                POST /api/plugins/{refresh,toggle,all}
GET  /api/skills                 POST /api/skills/{refresh,toggle,all}
GET  /api/receipts               GET /api/receipts?name=...
GET  /api/rag                    POST /api/rag/{index,search}
GET  /api/memory                 记忆五层快照（dir/slug/injectChars/block/layers）
POST /api/compress
GET  /api/llamacpp/status        POST /api/llamacpp/{start,stop}   POST /api/llamacpp/mode {mode}
GET  /api/events                 SSE 事件流（含 thinking_stage / thinking_plan / thinking_verify / receipt）
```

## 6. 接 LLMpod

LLMpod 暴露的是 OpenAI 兼容网关。本应用不需要改代码，只改配置（前提：你有一台 **Linux GPU 主机**，或租了一台——见下方「本机现状」）：

```jsonc
{
  "llamacpp": {
    "host": "http://<llmpod-gateway>:<port>",   // 需确认：以 LLMpod 控制台实际网关地址为准
    "autostart": false,
    "serverPath": "",
    "modelPath": "",
    "cudartPath": "",
    "mmproj": ""
  },
  "model": "llama/<部署在 LLMpod 上的模型 id>"   // 需确认：取 /v1/models 返回的 id
}
```

约束与前置条件（详见 `docs/迁移方案_LLMpod与Bonsai2.md`）：

- LLMpod 官方形态是 **Linux + Docker**，本机是 Windows 11 + 单张 RTX 5060 Laptop 8GB ⇒ **本机装不了 LLMpod**。要用只有两条路：① 租一台带 GPU 的 Linux 云主机（把 Bonsai 与 PrismML 运行时按方案部署上去，本应用当纯 HTTP 客户端）；② 不做 LLMpod，就用本机托管 llama-server（当前默认路径，功能等价、少一层网关）。
- 模型必须是 **PrismML 分支运行时**产出的服务，官方上游 llama.cpp 镜像加载 PTQ1_0 会 `bad_alloc`；若 LLMpod 默认镜像不含该补丁，需自定义镜像（文档给的 Dockerfile 要点）。
- 多模态要在**服务端**加载 mmproj（`--mmproj … --no-mmproj-offload`）；网关只转发 OpenAI content 数组，本应用侧无需额外配置（`llamacpp.mmproj` 只在托管模式用，远端模式留空）。
- `-c 32768` + q8_0 KV 在 8GB 显存上约 7.7GB，副本数只能 1。

## 7. 验证记录（2026-11-09，本机真机）

### 0.7.1（当前：四项开箱修补）

| 项目 | 结果 |
| --- | --- |
| 背景 | 自查出四项「机制在、开箱不可用」：压缩阈值口径错（≈4k token 就摘要）、RAG 只索引自身 `docs/`（3 文件 / 75 块）、记忆层全 0 条、技能面板 194 条淹没 6 条 |
| 修法 | `compress.contextSize(cfg, limit)` 优先取服务端 n_ctx（`ctxSize()` 从 `llamacpp.mjs` 导出、经 `llm.mjs` 转发）；`agent.mjs` 开跑前取真 n_ctx 传给 `compressSession({ctxLimit})`、`api.mjs` 的 state/手动压缩同口径。RAG：`rag.root:""` 跟随工作区 + `server.mjs` 启动自动建索引。记忆：`memoryEmptyHint(cfg)` 空库时把「用 memory 工具写入」提示拼进 system。技能面板：已启用平铺、其余折叠 + 字符数/来源/错误标注 |
| `node test/smoke.mjs` | **SMOKE PASS 228 / 0**（新增 11 项：live limit 三种优先级、`estimateContext` 预算、空库提示四态、`rag.root===""`、启动建索引静态断言、技能面板分组断言） |
| `/api/state`（生产 4790 重启后） | `version=0.7.1`、`ctx.contextSize=**131072**`（原 8192）、`ctx.ratio=0.5`、`rag={root:<工作区>, files:272, chunks:5000, truncated:true}`、`llama={mode:external,up:true}`、`tools=16`、技能 194/6 |
| `_scratch/compress_budget_probe.mjs` | 同一份 7,400 token 历史：带真 n_ctx ⇒ `budget=131072, should=false`（阈值 65,536）；不带 ⇒ `budget=8192, should=true` ⇒ 复现旧缺陷、证明新口径生效 |
| 启动日志（`_scratch/server-4790-v071.log`） | 首行 `RAG 索引已建：272 文件 / 5000 块（超过块数上限，已截断），1322 ms` |
| 记忆端到端（生产 4790，真实 27B） | run `r_mw8t3udh3kkc` done（3 步 / 1 工具 / 首字 19.0 s / 51.1 tok/s），`memory/memory.md` 写出「本机 Bonsai 工作台监听 4790 端口；模型走 D:\llm\ada 的 8080 外部端点」，`injectChars` 0 → 172；回执 `receipts/r_mw8t3udh3kkc.md` |
| 运行期真值 | 工作区首建索引 **1.4 s / 272 文件 / 5000 块 / 9.30 MB index**（撞 `maxChunks` 上限，`truncated=true`）⇒ 成本可接受，无需后台 worker |
| 边界 | 索引变宽后检索更噪：那次 4790 真跑检索到的是无关的 51 单片机文档 [S1]–[S6]，回答明确说「这两条事实不在资料里」，引用校验未误报 |

### 0.7.0（历史：端点模式一键切换 + 外部端点视觉 + 主界面联网开关）

| 项目 | 结果 |
| --- | --- |
| 背景 | 三条尾巴：① mmproj 在外部端点模式下不生效（视觉塔只有托管模式才加载）；② 回托管要手改配置；③ 联网搜索开关只在设置面板里 |
| `node test/smoke.mjs` | **SMOKE PASS 217 / 0**（新增 7 项：`modeOf` 三种推断、显式 mode 优先、`switchMode` 拒非法值、两套预设字段齐备、managed 预设带 mmproj / external 预设带 key 文件；应用配置断言 `mode === "external"`） |
| `_scratch/probe_v070_api.mjs`（16 项） | **PROBE_V070_API PASS**：`POST /api/llamacpp/mode {mode:"external"}` 幂等返回 `ok/up/mode`；非法 mode 回 `{ok:false,reason}` 不崩；`PATCH /api/config {webSearch:false}` 后工具数 **15→14**、勾回 **14→15** |
| `_scratch/ui_probe_v070.mjs`（16 项，无头 Edge + CDP，隔离 4793） | **UI_V070_PROBE PASS**：顶栏 `#websearch` 初值与配置同源、点击后真落盘；设置面板「端点模式」两档下拉、mmproj 输入框、应用模式按钮在；点应用模式 → 提示「已切到外部端点：http://127.0.0.1:8080（端点在线）」；控制台 0 报错；截图 `_scratch/ui-v070-main.png` / `ui-v070-settings.png` |
| `_scratch/probe_v070_managed.mjs`（12 项，真拉起进程） | **PROBE_V070_MANAGED PASS**：停掉 ada 后一键切托管 **4.6 s** 拉起 8082（pid 真进程）、真跑一轮对话 `run_end status=done`、切回 external 后自己拉起的 llama-server 已退出、配置回 8080/autostart=false |
| 外部端点视觉（ada 重启后） | 日志 `vision … on the CPU (no VRAM)`；`/props` `modalities.vision=true`、`n_ctx=131072`、`slots=1`；直连 `/v1/chat/completions` 带 1.3 KB PNG → 200/1.8 s 答「圆形，红色」 |
| 工作台带图 run（隔离 4795，外部端点） | **PROBE_V070_VISION PASS**：`POST /api/runs {images:[dataURL]}` → done 10.7 s，答「圆形+红色」；模型条 `工具·视觉` 全亮 |
| 生产 4790 | 重启到 **0.7.0**（旧 pid 2484 → 28336）：`mode=external`、`up=true`、`mmproj=""`、`webSearch=true`；带图 run done 13.2 s 答「圆形+红色」，测试会话已 DELETE |
| 边界 | 8 GB 卡上托管与 ada 8080 **只能二选一**：切托管前必须先停 ada（否则 spawn 失败/挤爆显存），切回 external 后要再启 ada（`D:\llm\ada\start-bonsai.cmd`） |

### 0.6.1（历史：外部端点 Bearer 鉴权）

| 项目 | 结果 |
| --- | --- |
| 背景 | 工作台自托管 8082 与 `D:\llm\ada` 的 8080 抢同一张 8 GB 卡 ⇒ 8082 报 `failed to create context`、加载权重还会把 8080 挤到 `CUDA error: out of memory`；改为一律连外部端点 |
| `node test/smoke.mjs` | **SMOKE PASS 209 / 0**（新增 7 项 `apiKey`：key 文件读取去空白 / 改文件+mtime 后重读 / inline `apiKey` 优先 / 都空返回空串 / 文件缺失返回空串；应用配置断言由 PrismML 托管改为外部端点） |
| `GET /api/state` | `version=0.6.1`、`up:true`、`host http://127.0.0.1:8080`、`managed:false`、`autostart:false`、`pid:0` |
| `GET /api/models` | `llama/bonsai-2-27b`、ctx **131072**、caps `["tools"]`（来自 ada 服务 `/props`） |
| `POST /api/llamacpp/start` | `{"ok":true,"already":true}`，`llama-server` 进程数仍 1 ⇒ 工作台只连不拉进程 |
| `_scratch/probe_8080_backend.mjs`（14 项） | **BACKEND_8080_PROBE PASS 14 / 0**：普通对话「接好了 [S1]」12.1 s；工具轮 `list_dir` 真调、21.2 s 回 5 个目录名；8080 全程存活 |
| `_scratch/live_probe_websearch_061.mjs`（外部端点，真实 27B） | run `r_mw7zezknadqn` **done**：模型自调 `web_search("llama.cpp release b12128")` 取 8 条，原样列标题+链接；明确声明 8 条均未命中 b12128、不编造版本信息；全程 92 s（含思考与 RAG 注入），会话已删 |
| 边界 | 首次探针曾把 8080 挤崩（`CUDA error: out of memory`，当时 tiered 线 `0..61696`、margin 仅 225 MiB），重启后线 `0..54272` 稳定；**max_tokens 不是原因**（130000 直发 HTTP 200、服务存活）。外部端点模式下 mmproj 不生效，视觉取决于服务端 |

### 0.6.0（历史：记忆分层 + 联网搜索 + 上下文翻倍）

| 项目 | 结果 |
| --- | --- |
| `node test/smoke.mjs` | **SMOKE PASS 202 / 0**（新增记忆 30 项 + 搜索后端 6 项：五层路径/条目格式/注入白名单与逐层截断/关层不注入/每日日志/跨层检索/唯一命中删除/未知层报错/工具注册与权限风险/关闭态报错/`resolveEngines`/缓存标记） |
| `_scratch/live_probe_060.mjs`（生产 4790，真实 27B，23 项） | **LIVE_PROBE_060 PASS 23 / 0**：`/api/state` 版本 0.6.0、工具 16、ctx 32768；run1 模型自调 `memory` 写入 key 层且文件含 pnpm；新会话 run2 **不再调工具**、直接答出 pnpm（注入生效）；run3 `web_search` 走 bing 且返回条数；三次 run 后每日日志 3 条且带 runId |
| `_scratch/ui_probe_060.mjs`（无头 Edge + CDP，18 项） | **UI_PROBE_060 PASS 18 / 0**：版本 v0.6.0、顶栏/运行面板 ctx 32,768、工具 16；设置面板「搜索后端」回填 auto 且三选项、「记忆分层」勾选与注入上限 2200 回填、`#mem-stats` 文案；点「查看记忆」出五层预览；控制台 0 报错（截图 `_scratch/ui60-settings.png`） |
| `GET /api/memory` | 五层快照（dir/slug/injectChars/block/layers）；`/api/state.memory` 为轻量摘要；空记忆时 `injectChars=0`（不占上下文） |
| 上下文加高（`_scratch/ctx_probe.mjs` / `ctx_verify.mjs`） | `-c 32768` + q8_0 KV：加载 7,685/8,151 MiB、4 提示首轮平均 **37.6 tok/s**（与 16384 同档）；**36,864 掉到 21.0、40,960 掉到 9.0、49,152+ 掉到 2.5 ⇒ 开始走 WDDM 分页**；真实 20,021 token 提示一次跑通（560 tok/s、35.8 s、正确回「收到」）⇒ 定稿 **-c 32768**（翻倍、零质量损失、速度不变） |

### 0.5.1（历史：生成速度实测与调优内化）

| 项目 | 结果 |
| --- | --- |
| `node test/smoke.mjs` | **SMOKE PASS 165 / 0**（新增 3 项：不默认开投机解码、`ctx.summaryChars` 落在 clamp 区间 [200,4000]、`test/bench.mjs` 在册） |
| `npm run bench`（对生产服务器，4 提示 × 3 轮） | 首轮平均 **38.3 tok/s**（chat 33.7 / code 41.0 / summary 40.6 / long 37.9）；所有首轮 `drafts=0`；重复轮 44.3→274.3 tok/s 由工具自动标注为缓存命中假象 |
| 变体 A/B（`_scratch/tune_probe.mjs`，11 个变体逐个重启） | `-ub 1024` −46%、`-b 4096 -ub 2048` 含 −45%、`--prio` +1%、`--cache-reuse`/`MMQ`/`no-graphs` 0%、`-ctk/ctv q4_0` +2.6%（有质量风险，不采用）⇒ 结论：无语义无损的正收益启动参数 |
| prefill 专项（`_scratch/prefill_probe.mjs`，4514 token） | base 604.5 / ub256 605.4 / b4096+ub1024 595.1 / b2048+ub512 594.8 / prio2 598.9 tok/s ⇒ `-b/-ub` 对 prefill 无影响，prefill 本身不慢 |
| 投机解码分离测（`_scratch/ab_spec.mjs`） | 首轮 tool 50.0→49.5、summary 47.6→46.8、code 48.5→48.2、rewrite 48.0→48.2 tok/s，输出逐字一致 ⇒ 真收益 0；此前 `tune_verify.mjs` 的 +52%/+217%/+689% 已判定为重复 prompt 假象 |
| 顺带修的缺陷 | `ctx.summaryChars` 原为 `1e+104`（`Infinity` 序列化产物），被 clamp 到 4000 ⇒ 摘要比默认 1200 长 3.3 倍、白烧 token；已改回 1200 并加 smoke 区间断言 |
| GPU 采样（`_scratch/clock_probe.mjs`） | 2790–2805 MHz / 3090、62–69 °C、约 97 W、util 98–99% ⇒ 无热降频，decode 受显存带宽限制 |

### 0.5.0（历史：会话删除 + 运行中会话置顶）

| 项目 | 结果 |
| --- | --- |
| `node test/smoke.mjs` | **SMOKE PASS 162 / 0**（新增 6 项：DELETE handler 回 200/ok、删后会话不存在、删不存在的 id 回 `ok:false`、`sessionHasLiveRun` 运行中/已结束/跨会话三种判据） |
| `_scratch/ui_probe_v050.mjs`（无头 Edge + CDP，16 项） | **UI_V050_PROBE PASS 16 / 0**：隔离实例 4791，造 3 个会话并把「中间的会话」伪造为运行中（fetch 拦截 `/api/state`）⇒ 该行置顶且默认打开、带「运行中」徽标、删除按钮置灰；每行都有 `×`；点 `×` 确认后行数 3→2 且磁盘 `/api/sessions` 同步少一条；删当前会话后回空态（`#messages .empty`）、不再有 active 行；控制台 0 报错 |
| 截图 | `_scratch/ui-v050-sessions.png`、`_scratch/ui-v050-empty.png` |
| 服务端守卫 | 运行中的会话删除 → 409（`{error, runId}`）；判据函数 `api.sessionHasLiveRun` 已由 smoke 覆盖，HTTP 路径与前端置灰共用同一判据 |

### 0.4.0（历史：思考路径 PSV + 强制回执）

| 项目 | 结果 |
| --- | --- |
| `node test/smoke.mjs` | **SMOKE PASS 156 / 0**（新增思考路径与内置回执 29 项：计划解析/兜底/自检、回执 md 段结构与 json 字段（含 `receipt.version`）、落盘、非法 runId 拒绝重建） |
| `_scratch/live_v040_probe.mjs`（生产 4790，真实 27B，54 项） | **LIVE_V040_PROBE PASS 54 / 0**：三种结局（done / error「达到最大步数 1」/ stopped）都出 `receipt` 事件、md+json 落盘；md 结论分别为 ✅ 完成 / ❌ 出错（含错误原文）/ ⏹ 已停止；md 均含「做了什么 / 验收证据 / 边界与未验证 / 下一步」四段；json 带 `receipt.version` |
| `_scratch/ui_probe_v040.mjs`（无头 Edge + CDP，24 项） | **UI_V040_PROBE PASS 24 / 0**：设置面板 RAG/压缩段无回归；真跑一轮页面出现「思考路径 · 计划（模型 · 4.8 s）」编号步骤、「自检提示缺 结论段」、「回执已生成（4.8 KB）」sysline（run_end 重渲染后仍在）；右栏点 `.md` 行预览出「# 回执报告 · … **结论**：✅ 完成」；控制台 0 报错 |
| `_scratch/interrupted_probe.mjs`（离线造盘，11 项） | **INTERRUPTED_RECEIPT_PROBE PASS 11 / 0**：`markInterrupted()` + `writeInterruptedReceipts()` 给 status=running 的落盘 run 补写回执，md 结论「⚠ 已中断 — 进程重启导致运行中断，已从落盘数据补写本回执」，json.status=interrupted，已写过的不重复补 |
| 真机数字 | 版本 0.4.0、工具 15、ctx 16384；单轮规划 ≤180 token（模型规划 4.5–5.2 s）；done 回执 4,491 B（17.3 s / 2 步 / 42.4 tok/s / 提示 5,145 + 生成 158）；error 回执 3,674 B；RAG 命中 64 取 6 |
| 截图 | `_scratch/ui-v040-{main,settings,run,receipt}.png` |

### 0.3.0（历史：RAG + 上下文压缩）

| 项目 | 结果 |
| --- | --- |
| `node test/smoke.mjs` | **SMOKE PASS 127 / 0**（新增 RAG 切块 / BM25 / 引用校验 / 压缩计划 33 项） |
| `_scratch/live_rag_probe.mjs`（真机 4791 + 隔离数据目录） | **LIVE_RAG_PROBE PASS 21 / 0**：中文检索命中且带 file:line、真实 run 出 `rag_retrieved` 与 `rag_verify` 且答案带 `[S2]`、资料里没有的问题在检索预算耗尽后明确弃答（列「缺什么」）、`/api/compress` 摘要落盘（summaryUpTo=14 / 913 字 / 24 条原文不丢） |
| `_scratch/ui_probe_rag.mjs`（无头 Edge + CDP，24 项） | **UI_RAG_PROBE PASS 24 / 0**：设置面板 RAG/压缩段与状态行、面板内试检索出 `[S1] 文件 · 行 200-209`、UI 真跑一轮出现「知识库命中 6 条」「引用校验通过：S6, S3」sysline 且答案带 `[S#]`、控制台 0 报错 |
| `_scratch/prod_verify_4790.mjs`（生产 4790，真实配置/真实 docs） | **PROD_VERIFY PASS 14 / 0**（11 s）：索引 3 文件 / 75 块、检索命中 61 取 6、run **1 步**结束、答案带 `[S1]` 且 0.72 / 10 / 1200 全对（「资料已检索好就不要翻文件系统、2 步内结束」规则生效） |
| 真机数字 | ctx 16384、工具 14；索引 2 文件 / 57 块 / 10,330 词 / 150KB，检索 1ms；压缩摘要 913 字覆盖 14 条 |
| 截图 | `_scratch/ui-rag-{main,settings,search,run}.png` |

### 0.2.0 多模态（历史）

| 项目 | 结果 |
| --- | --- |
| `node test/smoke.mjs` | **SMOKE PASS 89 / 0**（含图片入参与 mmproj 参数 21 项） |
| `_scratch/live_probe_4790.mjs`（真机 4790 + PrismML llama-server） | **LIVE_PROBE PASS 19 / 0**（普通对话、工具调用、回执 md/json、插件钩子） |
| `_scratch/vision_live_probe.mjs`（真机 HTTP 全链带图） | **VISION_LIVE PASS**：`ui9-main.png` 56,972 B → data URL 75,986 字符，wall 20.2s，答复准确读出图内首行「请调用 plugin_demo-tools_sha256 工具…」 |
| `_scratch/ui_probe_4790.mjs`（无头 Edge + CDP，35 项） | **UI_PROBE PASS 35 / 0**（版式、端点徽标、模型下拉含「视觉」、设置、回执预览、附件条增删、UI 带图真发一轮、控制台 0 报错） |
| 真机数字 | ctx 16384、工具 13、回执 16；纯文本一轮 0.4s、首字 344ms；带图一轮 UI 实测 **28.4s**（首字 27.1s，含 CPU 视觉编码 ~14s）；direct 探针 wall 16.1–17.5s / prompt 73–77 tok/s / decode 43.5 tok/s |
| 截图 | `_scratch/ui-bonsai-{main,receipt,settings,vision}.png` |

## 8. 已知边界

1. **单端点单模型线**：模型列表只来自一个 `/v1/models`；不管理多副本、不做负载均衡（交 LLMpod）。
2. `-np 1` 是单客户端口径：多客户端并发要另外规划（多开 server 或多副本）。
3. 8GB 显存下 `-c 32768`（q8_0 KV）约 7.6–7.7 GB 即上限；实测 36,864 起速度掉到 21 tok/s、40,960 掉到 9、49,152+ 掉到 2.5（WDDM 分页），不要超过 32768。含 mmproj 时 7352/8151 MiB。
4. **视觉能力取决于服务端是否加载 mmproj**：外部端点模式下工作台自己不加载，只靠服务端 `/props` 的 `modalities.vision` 显示「视觉」（0.7.0 起本机 ada 启动器默认导出 `BONSAI_MMPROJ`，实测已亮）；远端网关没带 mmproj 时模型条不会亮视觉，图片会被模型当噪声。
5. 视觉编码跑在 CPU（`--no-mmproj-offload` 为省显存的取舍）：每张图约 **14s** 编码 + ~1100 prompt token，单图轮次总耗时 16–28s；要更快得把 mmproj 放进 GPU，但 8GB 卡没余量。
6. 视觉分辨率固定 1280 长边、JPEG 0.86（前端压的），小字/表格类图会掉细节；需要更高清时应改 `downscaleImage()` 的上限并接受更大的 prompt。
7. **回执是内置产物（0.4.0 起）**：由 `controller/runs.mjs` 在正常/异常/停止/中断路径统一落盘，不依赖插件；插件写同名文件会被内置回执覆盖。进程被**硬杀**时当轮回执补写在下次启动（`initRuns`）。
8. 工具/MCP/插件代码在本进程内执行，权限档是唯一护栏；不可信插件别装。
9. 宿主 Windows 11 已验证；Linux 未实测（代码无平台相关依赖，理论可直接跑，**需确认**）。
10. **RAG 是词法检索不是语义检索**：BM25 靠原文用词，问法与原文用词不一致时（同义词、跨语言、口语句）会漏；中文靠单字+双字兜底，改写幅度大的长文档仍可能检索不到。语义检索需要 embedding 模型，8GB 卡上得与 27B 分时（本机未做）。
11. **引用校验只拦形式**：只判「编号不存在」和「有资料却零引用且未弃答」，不判断引用内容是否真的支持结论——引对编号但断章取义仍可能发生；摘录引文与原文对不上只记 warning。
12. **压缩摘要来自同一个 27B**：长会话多次压缩会累积信息损失（每轮只对上一段原文重算摘要，不叠加旧摘要）；摘要失败时退回硬裁，可能丢上下文。阈值跟服务端真实 n_ctx 走（0.7.1，缓存 30 s），换端点/改 `-c` 后会即时跟随；改大仍要同步看显存。
13. **索引是同步构建，且启动时自动建**（0.7.1）：索引缺失或工作区根变了，服务启动时会同步重建（本机工作区 1.3 s / 272 文件），很大的目录会拖慢启动；上限 1500 文件 / 5000 块，超出部分不进索引——本机 272 文件就已撞 5000 块上限（`truncated=true`），要更全得调 `rag.maxChunks`。
14. 检索预算（4 次 search / 1 次 index）是经验值：它救了上下文，但也可能让多跳问题拿不到足够资料——需要更细的检索策略时改 `model/agent.mjs` 里的 `RAG_SEARCH_BUDGET`。
15. **「资料已给就别再翻文件系统」靠提示词约束**：引用规则第 4/5 条只是强提示，同一模型在别的问法下仍可能去 `dir`/`list_dir` 探索；真遇到长跑空转可用 `停止`，或收紧 `maxSteps`/工具权限。
16. **规划调用是额外开销**：每次 run 多一次 LLM 小请求（≤180 token，实测约 1–3s）；嫌慢可 `thinking.planCall=false`，计划段改用确定性兜底。
17. **自检是软判据**：默认只检查「结论 / 依据 / 自检」结构是否存在并写回执，不判断内容真伪；`requireSelfCheck=true` 才会缺段重写一次（仍可能重写后依旧缺）。
18. **回执反映事件、不反映真相**：步数/工具/耗时/引用来自 run 事件，模型自述的内容按原样摘录；「验收证据」表的判定基于事件与文件存在性，不代表外部事实已被验证。
19. **记忆是字面检索不是语义检索**：同义改写（存「pnpm」搜「包管理器」）搜不到；五层里只有 user/memory/key 自动注入，`project`/`daily` 必须模型主动 `memory(action='search')`。注入总长 2200 字符，条目多了要人工整理。
20. **一键切托管有单卡前提**：8 GB 卡上工作台托管的 llama-server 与 ada 的 8080 只能存在一个。切 managed 前先停 ada（`D:\llm\ada\stop-bonsai.ps1`），切回 external 后再启 ada（`start-bonsai.cmd`）；不照这个顺序会 spawn 失败或把显存挤爆（报 `failed to create context`）。
21. **搜索只有 Bing 稳定可用**：本机 DDG/Brave/Searx 全 `fetch failed`（约 10.5 s 超时），`auto` 下先试 sticky 引擎、DDG 只给 6 s；缓存只在进程内、重启即失，陈旧结果不会跨进程复用。Bing 中文泛查询质量一般，精确型号/英文词更可靠。
22. **默认索引整个工作区会带来检索噪声**（0.7.1）：无关文档也会被取进 [S#] 预算（≤5200 字），实测「4790 端口」类问题会命中 51 单片机笔记；模型会自己说「不在资料里」、引用校验不误报，但 prompt 白烧。要精准就把 `rag.root` 收窄到子目录。
23. **空库记忆提示只是提示词**：模型可能仍然不写（多数会写）；`project`/`daily` 依旧不自动注入，需要模型主动 `memory(action='search')`。

## 9. 相关文档

- `docs/UI设计说明.md`：设计令牌、三栏版式、组件与交互、验收口径。
- `docs/RAG与上下文压缩设计.md`：RAG 切片 / 索引 / BM25 / 引用校验与上下文压缩的设计、参数、边界与复跑口径。
- `docs/思考路径与回执设计.md`：PSV 思考路径与强制回执的 GitHub 依据、模块/事件/格式、验收与边界。
- `docs/性能调优.md`：生成速度实测（decode/prefill/带宽推算）、11 个启动参数变体的结论表、投机解码基准假象的成因与读法、`npm run bench` 用法。
- `docs/记忆分层与联网搜索.md`：五层记忆的文件布局/注入上限/工具与 API，搜索后端选择、sticky 与缓存策略、本机网络真值与边界。
- `docs/迁移方案_LLMpod与Bonsai2.md`：Ollama → llama.cpp → LLMpod → Bonsai 2 27B 的 9 节迁移方案（含「无 Linux GPU 主机」下的两条路、多模态落法、自定义镜像与回滚）。
- `../bonsai2-migration/`：早期迁移调研、GGUF 提取/下载脚本、Dockerfile 初稿、实测记录。
