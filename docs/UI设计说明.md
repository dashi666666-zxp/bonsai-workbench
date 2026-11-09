# Bonsai Workbench · UI 设计说明

版本 0.5.0｜2026-11-08｜纯手写 HTML/CSS/JS，无框架、无外链字体、无静态图片资源（消息里的图是用户上传的 data URL）。

## 1. 设计目标

Bonsai 线是「推理基础设施」而不是聊天玩具，界面按**控制台**设计：一眼看到端点健康、模型能力、运行成本，其次才是对话。三条原则：

1. **状态先行**：端点是否在线、是否托管、ctx、工具数、pid、启动参数常驻可见，不需要点开设置。
2. **一次成型**：发送即出完整运行轨迹（步骤、工具、耗时、token），不靠滚日志猜进度。
3. **两条线视觉可分**：Ollama 工作台是暖黑 + 红，Bonsai 用更冷的黑底 + 纸白 + 信号红，版式改为三栏（左会话 / 中对话 / 右控制台），扫一眼就知道在哪个应用里。

## 2. 设计令牌

```css
--bg: #070605;      /* 页面底 */
--bg-1: #0d0b0a;    /* 卡片 */
--bg-2: #141110;    /* 输入 / 下拉 */
--bg-3: #1b1715;    /* 悬浮 */
--line: rgba(242,236,225,.16);   /* 细边 */
--line-2: rgba(242,236,225,.42); /* 主框线（顶栏 / 面板分隔） */
--paper: #f2ece1;   /* 正文 */
--paper-2: #cfc6b8; /* 次要文字 */
--mute: #8b8277;    /* 说明文字 */
--red: #c8102e;     /* 品牌 / 主按钮 / 运行态 */
--red-hi: #e11f3a;  /* 悬浮 */
--red-txt: #ef4d63; /* 错误文字 */
--sans: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
--mono: "Cascadia Code", Consolas, "Courier New", monospace;
--radius: 2px;      /* 直角，仅 2px 微圆 */
--ease: cubic-bezier(.16,1,.3,1);
```

硬约束：**无衬线、直角、零阴影、零渐变背景、无外链资源**。红色只用于品牌标记、主按钮、运行中状态、错误；大面积用纸白与灰。

## 3. 版式

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏 54px：◈ Bonsai v0.5.0 │ 端点徽标 │ 模型下拉 │ ctx │ 工具 │ 思考 │ 权限 │ 回执 │ 设置 │ 停止 │
├──────────────┬───────────────────────────────┬───────────────┤
│ 左 268px     │ 中 1fr                        │ 右 344px       │
│ 会话列表     │ 消息流（用户/助手/工具卡）     │ 运行面板       │
│ 最近运行     │ 用户消息可带图片（≤4 张）      │ 指标网格       │
│ 数据目录     │                               │ 工具流水       │
│ 工作区       │ 附件条 + 输入框（运行中=追加） │ 回执列表+预览  │
└──────────────┴───────────────────────────────┴───────────────┘
```

- `#app { display:grid; grid-template-columns: 268px minmax(0,1fr) 344px; grid-template-rows: 54px minmax(0,1fr) }`。
- ≤1180px：收掉右栏（232px 侧栏 + 对话）；≤820px：只留顶栏 + 对话。
- 所有滚动区域 `min-height:0` + `overflow:auto`，长内容不撑破网格。

## 4. 组件

| 组件 | 说明 |
| --- | --- |
| 顶栏 `.topbar` | 品牌/版本、端点徽标（`.conn.is-up/.is-down` + 托管 pid）、模型下拉、ctx、工具数、思考开关、权限档、回执/设置按钮、停止按钮 |
| 会话行 `.sess` | 标题 + 时间 + 模型；选中态左侧 2px 红线。次序＝运行中置顶，其余按最近更新（`sortedSessions()`；服务端只按 `updatedAt`，运行中的会话跑完前不刷新它） |
| 运行中会话（0.5.0） | `.sess.running` 左侧红线改 `--red-txt` + 时间行前置 `.sess-badge`「运行中」；行内删除按钮同时置灰（title「运行中的会话不能删除，先点「停止」」） |
| 删除按钮 `.sess-del`（0.5.0） | 会话行右上角 `×`（18×18，默认透明边框、hover 出红线），`stopPropagation` 后 `window.confirm` → `DELETE /api/sessions/:id`；删当前会话则清空选择并 `renderMessages(null)` 回空态 |
| 消息 `.msg` | 用户（右侧边框红线）/ 助手（纸白正文）/ 思考折叠（`<details>`，灰字）/ 工具卡（名称、耗时、参数与输出折叠） |
| 带图用户消息 `.msg-imgs` | 图片缩略（`.msg-imgs img` 最大 240×180，`object-fit:contain`，2px 直角边框），点击 `window.open` 看原图；文字在 `.msg-text`（`white-space:pre-wrap`） |
| 附件条 `.attach-bar` | 输入框上方的待发图片区：`[hidden]` 时整体不占位；每张一个 `.attach-chip`（40×40 缩略 + 右上 `.attach-x` 移除）；`#composer.drag-over` 时整框 1px 描边变红提示可放下 |
| 「＋图」按钮 `.btn.ghost` | composer 左下，打开隐藏的 `#file-input`（`accept="image/*" multiple`）；与粘贴、拖拽三条入口等价 |
| 运行面板 `.card` | 端点、模型、ctx、启动参数、pid、启动/停止端点按钮 |
| 指标网格 `.stat-grid` | 4 列：步数、输入 tok、输出 tok、tok/s；「首字 · 首答 · 总」耗时条 |
| 工具流水 `.tool-flow` | 每次工具调用一行：名称、ok/拒绝、耗时 |
| 回执列表 `.receipt-row` | 文件名（.md/.json）、时间、大小；点击加载 md 预览到 `<pre>` |
| 设置弹层 `.modal` | 端点/托管/三路径/extraArgs/工作区/权限/审批/最大步/temperature/能力开关/RAG 段/压缩段/MCP JSON/插件技能开关/保存；`.modal[hidden]{display:none}` 保证 hidden 生效 |
| RAG 设置段（0.3.0） | 知识库目录 `#f-ragRoot`、三个开关（启用/自动检索/要求引用）、`#f-ragTopK`、`#f-ragMaxChars`、`#f-chunkSize`、`#f-overlap`、状态行 `#rag-stats`（索引文件/块数/时间/KB/⚠ 目录已变更）、试检索 `#rag-q` + `#btn-rag-search` + 重建 `#btn-rag-index`、结果 `#rag-result`（`[S#] 文件 · 标题 · 行 a-b · 分` + 正文 400 字） |
| 压缩设置段（0.3.0） | 开关 `#f-ctxEnabled`、触发比例 `#f-ctxRatio`、保留条数 `#f-keepRecent`、摘要字数 `#f-summaryChars`、状态行 `#ctx-stats`（上下文 tok · 触发比例 · 保留条数 · 摘要上限）、`#btn-compress-now` 立即压缩 |
| 系统提示行 `.sysline` | 运行状态与检索/压缩/思考路径/回执提示：每行一句 `<b>标题</b><span>细节</span>`。`rag_retrieved / rag_miss / rag_verify / thinking_plan / thinking_verify / receipt / ctx_compressed / ctx_info` 八类按会话缓存在 `state.notices`（最近 40 条），`run_end` 重渲染后仍可见；其余临时提示不缓存 |
| 思考路径提示（0.4.0） | `thinking_stage` 把运行状态行改成「思考路径 · 制定计划」；`thinking_plan` 出「思考路径 · 计划（模型 · Nms）/（确定性兜底）」+ `1) … 2) …` 步骤串；`thinking_verify` 出「自检通过」或「自检提示：缺 结论段」 |
| 回执行（0.4.0） | `receipt` 事件出「回执已生成（N B）」+ md 路径；生成失败出「回执生成失败」+ 错误。回执是内置产物，`<BW_DATA>/receipts/<runId>.md` 与旧插件同名同路径 |
| 审批弹层 | 工具名 + 参数摘要 + 拒绝/允许 |

## 5. 交互与状态

- **SSE 实时**：`/api/events` 推送 run 事件；助手文字按 delta 追加；`step` 更新步数；`tool_start/tool_end` 追加工具流水；`usage` 更新 token/tok/s；`run_end` 拉一次 `/api/state` 刷新会话/回执。
- **耗时条**：从 `run_start` 开始、首个 content delta 记首字、首个完整答复记首答、`run_end` 记总；`run_end` 后 `refreshState()` 会重渲染，因此用 `state.lastMetrics` 兜住最后一次数字，避免被清成「—」。
- **运行中发送** → `POST /api/runs/:id/steer`，作为追加要求进入下一步，不打断当前流式输出。
- **审批**：权限档 `ask` 时弹审批层，`POST /api/runs/:id/approve` 回执；`auto` 直接放行，`never` 直接拒绝。
- **无会话时发送**：先 `POST /api/sessions` 建会话再发 run，不要求用户先点「新建会话」。
- **图片的三条入口**：① 点「＋图」→ 系统选图；② 在输入框粘贴（`paste` 事件里扫 `clipboardData.files`）；③ 拖到 composer（`dragenter/dragover/dragleave/drop`，拖期间 `drag-over`）。三条都走同一个 `addImageFiles()`。
- **图片处理**：选中即压 —— canvas 把最长边缩到 1280、JPEG 0.86，转 data URL 进 `state.attachments`，同时 `renderAttachBar()` 出缩略图；超过 4 张截断并提示，压完仍 >3,000,000 字符报错不加入。
- **发送**：纯图（无文字）也允许；运行中有附件时直接拒绝发送并提示「运行中只发文字追加要求」；发送成功后 `state.attachments` 清空、`.attach-bar` 回到 `hidden`。
- 动效只有 `.modal` 淡入与消息卡轻微上浮（≤240ms，`--ease`）；`prefers-reduced-motion: reduce` 全部关闭。
- **检索与压缩的可见性（0.3.0）**：SSE 的 `rag_retrieved` / `rag_miss` / `rag_verify` / `ctx_compressed` / `ctx_info` 都落成 `.sysline`——「知识库命中 N 条（字数 · 耗时）」+ `S1 file:line · …`、「知识库未命中」+ 原因、「引用校验通过：S6, S3」/「引用校验未通过」+ 原因、「历史已压缩：before → after 条消息」。这类行按 sessionId 缓存，运行结束触发 `refreshState() → selectSession() → renderMessages()` 后仍在（否则用户永远看不到引用校验结果）。
- **RAG 状态前置**：设置面板打开即用 `/api/state` 里的 `rag` / `ctx` 渲染状态行（不额外请求）；`重建索引` 与 `试检索` 走 `POST /api/rag/{index,search}`，结果就地显示、不弹窗。
- **思考路径与回执的可见性（0.4.0）**：计划、自检、回执三类事件同样落成 `.sysline` 并缓存——「思考路径 · 计划（模型 · 812ms）1) … 2) …」、「自检通过 / 自检提示：缺 结论段」、「回执已生成（5,231 B）+ 路径」。它们与检索类共用 `state.notices`，所以 run 结束重渲染后仍在；回执列表本身在右栏，点开仍是 md 预览。

## 6. 验收与证据

### 0.5.0（当前）

1. **静态**：`node test/smoke.mjs` → **162/0**（新增 6 项：DELETE handler 200/ok、删后不存在、删不存在的会话回 `ok:false`、`sessionHasLiveRun` 三判据）。
2. **界面探针**：`_scratch/ui_probe_v050.mjs`（隔离实例 4791 + 无头 Edge + CDP）→ **UI_V050_PROBE PASS 16 / 0**：`/api/state` 拦截把「中间的会话」标成 running ⇒ 置顶并默认打开、带「运行中」徽标、删除按钮置灰；点 `×` 确认后真删（行数与 `/api/sessions` 同步）；删当前会话后回空态；控制台 0 报错。
3. 截图：`_scratch/ui-v050-sessions.png`、`_scratch/ui-v050-empty.png`。

### 0.4.0（历史）

1. **静态**：`node test/smoke.mjs` → **156/0**（含思考路径与内置回执 29 项）。
2. **真机探针**：`_scratch/live_v040_probe.mjs`（生产 4790）→ **LIVE_V040_PROBE PASS 54 / 0**；覆盖正常 / 失败（`maxSteps:1`）/ 中断（起跑后 stop）三种结局都出回执。
3. **界面探针**：`_scratch/ui_probe_v040.mjs`（无头 Edge + CDP）→ **UI_V040_PROBE PASS 24 / 0**；页面出现计划 / 自检 / 回执 sysline（`run_end` 重渲染后仍在），右栏 `.md` 预览出回执标题与结论，控制台 0 报错。
3. **UI 断言**：计划步骤串、自检结论、回执字节数与路径三类 sysline 在 `run_end` 后仍可见（依赖 `state.notices` 缓存）。

### 0.3.0（历史）

1. **静态**：`node test/smoke.mjs` → **127/0**（含 RAG 切块 / BM25 / 引用校验 / 压缩计划 33 项）。
2. **HTTP 真机**：`_scratch/live_rag_probe.mjs`（服务 4791 + 隔离数据目录）→ **LIVE_RAG_PROBE PASS 21 / 0**：中文检索命中带 file:line、真实 run 出 `rag_retrieved`/`rag_verify` 且答案带 `[S2]`、无依据问题在检索预算耗尽后弃答、`/api/compress` 摘要落盘（summaryUpTo=14 / 913 字 / 原文不丢）。
3. **UI 真机探针**：`_scratch/ui_probe_rag.mjs`（无头 Edge + CDP，24 项）→ **UI_RAG_PROBE PASS 24 / 0**。覆盖：标题/版本 v0.3.0、端点在线、ctx 16,384、工具 14、三栏；设置面板知识库目录/三个 RAG 开关/topK 6/maxChars 4200/分块 700·重叠 120/`#rag-stats` 索引 2 文件·57 块/`#ctx-stats` 上下文 16,384 tok·触发 72%·保留 10 条/「立即压缩」按钮；面板内试检索 → `#rag-result` 出 `[S1] 迁移方案_LLMpod与Bonsai2.md · 行 200-209`；UI 新建会话真跑一轮 → 页面出现「知识库命中 6 条」「引用校验通过：S6, S3」sysline、答案带 `[S#]` 且提到 llama.cpp 运行时；控制台 0 报错。
4. 截图：`_scratch/ui-rag-{main,settings,search,run}.png`。

### 0.2.0 多模态（历史）

1. **静态**：`node test/smoke.mjs` → 89/89（含不存在 Ollama 模块、图片入参、mmproj 参数的断言）。
2. **HTTP 全链带图**：`_scratch/vision_live_probe.mjs` → **VISION_LIVE PASS**（建会话 → `POST /api/runs` 带 data URL → 轮询 run_end → 回读会话），wall 20.2s，答复准确读出图内首行文字。
3. **UI 真机探针**：`_scratch/ui_probe_4790.mjs`（无头 Edge + CDP，35 项）→ **PASS 35 / 0**。覆盖：标题与版本 0.2.0、端点徽标、模型下拉唯一项 `bonsai-2-27b · ctx 16,384 · 工具 · 视觉`、顶栏 ctx、工具 13、数据目录 `.bonsai-workbench`、端点 8082、启动参数含 `-np 1`、三栏列宽、回执 md 预览、设置面板字段、**附件条（初始 hidden → 选图出 1 张 1280 宽 JPEG 缩略 → 点 × 归零）**、**UI 带图真发一轮**（用户气泡 `img=1`、发送后附件条 hidden、答复对上图内文字、耗时条 `首字 27.1 s · 首答 27.1 s · 总 28.4 s`）、控制台 0 报错。
4. 截图：`_scratch/ui-bonsai-main.png`、`ui-bonsai-receipt.png`、`ui-bonsai-settings.png`、`ui-bonsai-vision.png`（0.1.0 的 `ui-bonsai-done.png` 是纯文本轮次，已过期）。

## 7. 硬约束对照

| 约束 | 落地 |
| --- | --- |
| 无衬线 | 全部 `--sans`；代码/数字用 `--mono`（等宽不等于衬线） |
| 直角 | `--radius: 2px`，无大圆角 |
| 无阴影 | `box-shadow: none`（仅 `box-shadow: none` 显式覆盖） |
| 无渐变背景 | `background: var(--bg)` 纯色 |
| 无外链资源 | 零字体/零静态图片/零 CDN，图标仅 ◈ 字符与 CSS 绘制的「＋图」；消息图片全为本地 data URL |
| 无框架 | 原生 DOM + 事件委托，`app.js` 单文件 |
| 状态可见 | 端点/模型/ctx/工具/pid/参数常驻右栏与顶栏 |

## 8. 已知限制

- 单栏宽度固定像素，未做 4K 超宽屏适配（右栏可再加宽）。
- 无键盘快捷键（发送 Enter、换行 Shift+Enter 已支持）。
- 消息不是虚拟列表，超长会话（>2000 条）滚动性能未压测。
- 三栏在 1024×768 上会触发 1180px 断点收右栏，属于预期降级。
- 图片只在 composer 层压缩一次；不支持从消息里二次裁剪/旋转，也不能撤回已发出的图。
- 缩略图是同一张 data URL，长会话里多图会显著加大内存（每张 ~76KB 量级，1280 长边）。
