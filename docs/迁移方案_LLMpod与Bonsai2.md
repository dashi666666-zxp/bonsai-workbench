# 迁移方案：Ollama → llama.cpp → LLMpod → Bonsai 2 27B

> 本文是「Bonsai 隔离线」的迁移方案：**目标栈只包含 llama.cpp / LLMpod / Bonsai 2 27B**，不回写 Ollama 线。
> 编写环境：Windows 11 + RTX 5060 Laptop 8GB；LLMpod 官方形态为 Linux + Docker。
> 标注「**需确认**」的版本号、地址、参数表示本机尚无法核实，落地前必须现场取证。
>
> **2026-11-08 两项输入已定**：① 本机**没有 Linux GPU 主机** ⇒ LLMpod 在本机装不了，阶段 B/C 只有「租云 GPU Linux 主机」或「放弃 LLMpod」两条路；② **要多模态** ⇒ 已在本机 llama.cpp 线上落地（`--mmproj … --no-mmproj-offload`，视觉塔放 CPU），8GB 卡不需要换卡。

## 0. 本机已知真值（方案输入）

| 项 | 值 |
| --- | --- |
| 当前 Ollama 模型 | `qwen3.5:4b`、`qwen2.5-Coder:7B`、`embeddinggemma-2:latest` |
| Ollama 模型目录 | `~/.ollama/models`（blob 即 GGUF，可直接提取，无需格式转换） |
| GPU | RTX 5060 Laptop，8GB 显存 |
| 目标权重 | `D:\llm\models\bonsai-2-27b\Ternary-Bonsai-2-27B-PTQ1_0.gguf`，5,946,648,928 B，sha256 `53107f53…33ee3` |
| 已验证运行时 | PrismML `prism-b12128-d7b2896`，Windows CUDA 13.3 x64，`llama-server.exe` + cudart 目录 |
| 已验证参数 | `-ngl 99 -fa on -c 16384 -ctk q8_0 -ctv q8_0 --jinja -np 1`，显存 7,674 / 8,151 MiB，decode ≈43–44 tok/s |
| LLMpod | **未安装、且本机装不了**（Windows，无 Linux GPU 主机）；只读过文档：Linux + Docker，Manager 8080 / 网关 8090，模型源 HF / 本机路径 / 上传——版本与自定义镜像支持 **需确认** |
| 多模态 mmproj | `629,246,976 B`（Q8_0）；**已实测可用**：`--mmproj <文件> --no-mmproj-offload` 让视觉塔跑 CPU，显存 7352/8151 MiB、纯文本零回归，单图 16–28s |
| 多模态请求体 | OpenAI content 数组 `[{type:'text'},{type:'image_url',image_url:{url:'data:image/png;base64,…'}}]`；`/props` 的 `modalities.vision=true` 可自检 |

## 1. 现状评估与信息缺口

### 1.1 现状

- 推理：Ollama 单机，模型为 Qwen/EmbeddingGemma；`llama.cpp` 仅作为 Bonsai 的旁路后端，两线共用过一个工作台，模型列表互相污染。
- 应用：`ollama-workbench`（4788）走 Ollama；`bonsai-workbench`（4790，新）只走 llama.cpp / OpenAI 兼容 `/v1`，已独立验证。
- 已有可行性结论：
  1. Ollama blob 是 GGUF 容器，`qwen3.5:4b` / `embeddinggemma-2` 可提取后直接用 llama.cpp 加载（`bonsai2-migration/tools/extract-ollama-gguf.ps1`）。
  2. **PTQ1_0 / PQ2_0 三值权重只有 PrismML 二进制能跑**；上游 llama.cpp b12189 加载 PTQ1_0 直接 `bad_alloc`（失败在加载期，尚属安全失败）。
  3. 8GB 显存是硬边界：27B + `-c 16384` + q8_0 KV 已 7.6GB，无副本余量。

### 1.2 信息缺口（需你补充，影响见括号）

| # | 缺口 | 影响 |
| --- | --- | --- |
| 1 | LLMpod 具体版本、安装方式（单机 Compose / K8s / 托管）、License | 决定自定义镜像与注册路径；K8s 下还要另做节点 GPU 调度 |
| 2 | LLMpod 是否允许/如何注册自定义镜像（docs 未写，需 `/openapi.json` 或厂家确认） | 不允许则只能走「发布中心 → 添加外部端点」接独立 llama-server |
| 3 | ~~是否有 Linux GPU 主机~~ **已答：没有**（2026-11-08） | 本机不能部署 LLMpod ⇒ 阶段 B/C 不执行；要上 LLMpod 只能租 GPU Linux 云主机（见 §4.0） |
| 4 | Bonsai 2 27B 官方 GitHub 仓库地址（拿到后才能固定 commit/权重清单） | 文档与 Dockerfile 里的下载步骤无法定死 |
| 5 | ~~是否要接多模态（mmproj）~~ **已答：要**（2026-11-08） | 已在 llama.cpp 线落地（视觉塔 CPU offload）；LLMpod 侧只需镜像里带 mmproj 与同样参数 |
| 6 | 目标上下文长度与并发（1 副本单槽 / 多副本） | 决定 `-c`、`-np`、显存与前端超时 |
| 7 | 可接受的停机窗口与回滚 SLA | 决定切换是蓝绿还是就地替换 |

## 2. 总体迁移架构

```
                     ┌──────────────────────────────────────┐
                     │           应用层（Windows）            │
                     │  bonsai-workbench (4790)  唯一客户端  │
                     │  OpenAI /v1：/v1/models、chat/completions │
                     └──────────────┬───────────────────────┘
                                    │ HTTP
   ┌────────────────────────────────┴────────────────────────────┐
   │                                                             │
[阶段 A：本机直连 — 已落地]                    [阶段 B/C：LLMpod — 需外租 Linux GPU]
llama-server（PrismML 分支，8082）              LLMpod 网关（8090）
- Bonsai 2 27B PTQ1_0                          └─ 部署：llama.cpp 引擎
- Windows + CUDA 13.3                             └─ PrismML 自定义镜像
- mmproj Q8_0（CPU offload）⇒ 可看图                └─ Bonsai 2 27B GGUF + mmproj
```

- **Ollama 逐步退出推理路径**：先让 `bonsai-workbench` 独占 llama.cpp（已完成），Ollama 仅保留为回滚资产，不再被新应用引用。
- **llama.cpp 是唯一推理引擎**：本机阶段直接托管进程；LLMpod 阶段把同一运行时封装成镜像交给平台调度。
- **Bonsai 2 27B 是运行时强绑定**：权重格式（PTQ1_0）决定必须用 PrismML 分支，平台默认 llama.cpp 镜像大概率不兼容（需确认），因此方案以自定义镜像为主路径。
- 两条线隔离：Ollama 的模型/数据/端口/桌面入口不迁移、不复用；本方案的产物只进 `bonsai-workbench`。

## 3. 第一步：Ollama → llama.cpp

### 3.1 模型格式确认与获取

1. **确认 Ollama 模型是 GGUF**：`~/.ollama/models/manifests/registry.ollama.ai/library/<model>/<tag>` 的 JSON 里 `mediaType=application/vnd.ollama.image.model` 指向 `blobs/sha256-…`，该 blob 即 GGUF。
   - 提取：`tools\extract-ollama-gguf.ps1`（本机已验，输出可直接被 llama.cpp 加载）。
   - 若要标准命名：`Copy-Item <blob> <name>.gguf` 即可，无需转换工具。
2. **Bonsai 2 27B**：优先拿官方/PrismML 发布的现成 GGUF（本机已有 `Ternary-Bonsai-2-27B-PTQ1_0.gguf`）；**不要**用 Ollama 的 `ollama pull` 代替（Ollama 侧运行时不一定支持三值格式）。
   - 下载走 HF 镜像时注意「先快后停」：用 8 段并行 + 缺失段 16MB 小块续传（脚本 `bonsai2-migration/tools/download-bonsai.ps1` 已含该逻辑）。
3. 校验：`sha256` 与发布清单比对；`gguf_dump`/`llama-cli --version` 均能识别 metadata 字段。

### 3.2 编译 / 选择 llama.cpp

- **Windows 本机（已验证）**：直接用 PrismML release `prism-b12128-d7b2896` 的 Windows CUDA 13.3 包 + `cudart-llama-…-cuda-13.3-x64.zip`；cudart 目录加入 PATH 或写进配置的 `cudartPath`。
- **Linux（LLMpod 镜像内，需确认 PrismML 分支构建方式）**：

```bash
# 环境：Linux x86_64 + CUDA 12.x/13.x + cmake ≥3.28
git clone <PrismML-llama.cpp 仓库地址，需确认> && cd llama.cpp
git checkout <prism-b12128-d7b2896 对应 commit，需确认>
cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"
# 产出：build/bin/llama-server、build/bin/llama-cli
```

- 构建参数建议：`-DGGML_CUDA=ON`（Bonsai 需要 GPU）、`-DLLAMA_CURL=OFF`（镜像内不需要下载）、`-DGGML_NATIVE=OFF`（跨机器可复现）。
- **需确认**：PrismML 分支的 patch 是否随源码提供（还是只发二进制）；若只有二进制，Linux 版是否有对应 release 包。

### 3.3 启动参数（8GB 单卡基线）

```bash
# Windows（已验证）
D:\llm\runtime\llama-prism-b12128-d7b2896-bin-win-cuda-13.3-x64\llama-server.exe ^
  -m D:\llm\models\bonsai-2-27b\Ternary-Bonsai-2-27B-PTQ1_0.gguf ^
  -ngl 99 -fa on -c 16384 -ctk q8_0 -ctv q8_0 --jinja -np 1 -a bonsai-2-27b ^
  --host 127.0.0.1 --port 8082

# Linux（镜像内同参）
llama-server -m /models/Ternary-Bonsai-2-27B-PTQ1_0.gguf \
  -ngl 99 -fa on -c 16384 -ctk q8_0 -ctv q8_0 --jinja -np 1 -a bonsai-2-27b \
  --host 0.0.0.0 --port 8082
```

- `-c 16384` 是 8GB 上的上限附近；**必须显式给 `-c`**，`-c 0` 会按模型 262,144 申请 KV 直接 OOM。
- `-np 1`：单槽串行，避免并发抢 GPU（默认 4 槽会把 prefill 从 620 tok/s 打到 24 tok/s）。
- `--jinja`：让 chat template 生效；`-a` 指定 alias，否则 `/v1/models` 返回完整路径。
- 若换更大显存：先抬 `-c`（32k/64k），再考虑 `-np` 与副本。

### 3.4 应用侧 API 改动点（本机已完成）

| Ollama 接口 | llama.cpp / OpenAI 兼容 | 处理 |
| --- | --- | --- |
| `POST /api/chat`（NDJSON） | `POST /v1/chat/completions`（SSE） | 适配层转流；`reasoning_content` → thinking |
| `POST /api/show` 的 capabilities | `/v1/models` + `/props` 的 `chat_template` | 模板含 tools 才给工具；ctx 取 `n_ctx` |
| `POST /api/embed` | `POST /v1/embeddings`（本应用未接） | 嵌入线整体不迁入 Bonsai 应用 |
| 模型名 | `/v1/models` 的 `id` | 内部统一加 `llama/` 前缀，UI 显示去前缀 |

`bonsai-workbench/model/llm.mjs` 是唯一适配点；`model/llamacpp.mjs` 负责 SSE、工具调用分片（`index` 在 tool_call 顶层）、`timings` → token 用量、`fitMessages` 按 ctx 裁历史。**不需要改 agent 主循环**。

### 3.5 验证命令与验收标准

```powershell
# 环境：Windows，服务已在 8082
curl.exe -s http://127.0.0.1:8082/v1/models
curl.exe -s http://127.0.0.1:8082/props
curl.exe -s http://127.0.0.1:8082/v1/chat/completions -H "Content-Type: application/json" -d '{\"model\":\"bonsai-2-27b\",\"messages\":[{\"role\":\"user\",\"content\":\"用三句话解释三值量化\"}],\"max_tokens\":200}'
```

验收：`/v1/models` 返回 alias；`/props` 的 `n_ctx=16384`；一次对话返回 200 且有 `usage`；`nvidia-smi` 显存 < 8GB；`tok/s` 与基线（43–44）同量级；`bonsai-workbench` 的 `SMOKE 89/0`、`LIVE_PROBE 19/0`、`VISION_LIVE PASS` 通过。

## 4. 第二步：llama.cpp 深度嵌入 LLMpod

### 4.0 前提判定：本机装不了（2026-11-08 已定）

LLMpod 官方形态是 **Linux + Docker**，本机是 Windows 11 + 一张 8GB Laptop 卡，**没有 Linux GPU 主机**。所以本节不是「本机执行步骤」，而是二选一的分支：

| 选项 | 做法 | 代价 | 结论 |
| --- | --- | --- | --- |
| **B1 租云 GPU Linux 主机** | 按 §4.1–§4.4 在那台机器上装 LLMpod（Compose：webserver + proxyserver + PostgreSQL + Redis），把 Bonsai GGUF 与 PrismML 镜像带过去 | 云 GPU 租金 + 权重 5.9GB 上传/下载 + 运维；本机仍只是 HTTP 客户端 | 只有在「要平台化调度/多模型/多人用」时才值 |
| **B2 不上 LLMpod（当前选择）** | 本机 `llama-server` 直接跑，`bonsai-workbench` 托管（§3 已落地，含多模态） | 无平台能力（多副本、灰度、审计面板） | **当前采用**：单机单槽已满足自用，省掉一层网关 |

即：**LLMpod 章节保留为「租到 Linux GPU 主机后的操作手册」**，本机不执行。若将来要上，优先走 B1，并在租机当天先验 §4.2 的镜像能否加载 PTQ1_0（官方上游镜像会 `bad_alloc`）。

### 4.1 控制台配置步骤（LLMpod Manager，默认 8080）

1. 「基础设施 → 模型管理 → 添加模型」：填名称、来源（HF / 本机路径 / 上传）、GGUF 文件；引擎选 **llama.cpp**。
2. 若模型文件在本机：先把 GGUF 放到 LLMpod 可访问的模型目录或对象存储，再登记路径。
3. 「新建部署」：选上述模型 + llama.cpp 引擎 + 镜像版本；算力选 GPU（型号按 Linux 主机实际卡）；上下文长度 16384；副本数 1（8GB 卡）。
4. CPU/GPU：GPU 全量层数（`-ngl 99` 等价）；CPU 只做调度与 tokenize；内存建议 ≥16GB（**需确认**主机规格）。
5. 启动参数：把 `--mmproj /models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf --no-mmproj-offload -fa on -ctk q8_0 -ctv q8_0 --jinja -np 1 -a bonsai-2-27b` 写进部署的 extra args（若控制台不暴露，走自定义镜像的 entrypoint）。

### 4.2 自定义镜像（主路径：平台默认镜像不含 PrismML 补丁）

```dockerfile
# 环境：Linux x86_64，CUDA 运行时基础镜像版本需与主机驱动匹配（需确认）
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libgomp1 libcurl4 && rm -rf /var/lib/apt/lists/*

# 1) PrismML 分支 llama.cpp（二进制或源码构建；源码需带 patch）
COPY llama-prism/ /opt/llama/
ENV LD_LIBRARY_PATH=/opt/llama:/usr/local/cuda/lib64:$LD_LIBRARY_PATH

# 2) 权重与 mmproj 都不打进镜像（5.9GB + 629MB），由平台挂载到 /models
VOLUME ["/models"]

EXPOSE 8082
ENTRYPOINT ["/opt/llama/llama-server"]
CMD ["-m","/models/Ternary-Bonsai-2-27B-PTQ1_0.gguf",\
     "--mmproj","/models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf","--no-mmproj-offload",\
     "-ngl","99","-fa","on","-c","16384",\
     "-ctk","q8_0","-ctv","q8_0","--jinja","-np","1",\
     "-a","bonsai-2-27b","--host","0.0.0.0","--port","8082"]
```

构建与推送：

```bash
# 环境：有 Docker + 可访问 LLMpod 镜像仓库的 Linux 机器
docker build -t registry.example.com/bonsai/llama-prism:prism-b12128 -f Dockerfile .
docker push registry.example.com/bonsai/llama-prism:prism-b12128
```

镜像注册到 LLMpod：

- 若平台支持「镜像仓库/自定义镜像」：在 Manager 的镜像/运行时管理里登记上面的 tag；
- 若平台只允许官方镜像目录（docs 未见自定义入口，**需确认**）：用 `/openapi.json` 找镜像相关 endpoint，或退回 §4.4 的「外部端点」方案。

### 4.3 部署参数建议（8GB 卡）

| 参数 | 建议 | 理由 |
| --- | --- | --- |
| 副本数 | 1 | 单卡 7.6GB，二副本必 OOM |
| 上下文 | 16384 | 已验证；32k 需换卡 |
| batch / ubatch | 默认 512/512（**需确认**平台上限） | 与显存/延迟平衡 |
| GPU 层数 | 99（全量） | 27B 放 CPU 会掉到个位数 tok/s |
| mmproj | `--mmproj … --no-mmproj-offload` | 视觉塔 629MB 放 CPU，显存零回归；代价是单图编码 ~14s |
| mmproj offload | **不要**开 | 8GB 卡开了就顶爆（27B + KV 已 7.6GB） |
| 健康检查 | `GET /v1/models` 或 `/health`，interval 10s | 平台默认可能只查 TCP |
| 启动超时 | ≥180s | 5.9GB 权重冷加载约 5–10s，平台冷启动更慢 |

### 4.4 端点健康检查与拓扑验证

```bash
# 环境：任意能访问 LLMpod 网关的机器
curl -s http://<llmpod-gateway>:8090/v1/models
curl -s http://<llmpod-gateway>:8090/props
curl -s http://<llmpod-gateway>:8090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"bonsai-2-27b","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

验证项：部署状态 Running、副本 Ready 1/1；网关能列出模型；聊天返回 200；LLMpod 监控里 GPU 显存与 llama.cpp 自报一致；kill 一个副本后平台能拉起（或至少告警）。

## 5. 第三步：切换为 Bonsai 2 27B

### 5.1 获取权重 / mmproj / 专用运行时

```bash
# 环境：Linux（或 Windows 下载后拷入模型目录）
# 1) 官方权重（GitHub Release / HF，地址需确认）
curl -L -o Ternary-Bonsai-2-27B-PTQ1_0.gguf <权重直链>
sha256sum Ternary-Bonsai-2-27B-PTQ1_0.gguf   # 应为 53107f53…33ee3
# 2) 专用运行时：PrismML llama.cpp 分支
git clone <PrismML-llama.cpp 仓库，需确认> && cd llama.cpp && git checkout <commit，需确认>
# 3) mmproj（要多模态就下；8GB 卡可兼得——放 CPU 不 offload 即可，见 §5.3）
curl -L -o mmproj-bonsai-2-27b.gguf <mmproj 直链，需确认>
```

### 5.2 PrismML 分支的编译 / 镜像集成

- 编译命令同 §3.2；产物 `llama-server` 放 `/opt/llama/`。
- 镜像集成：把 `llama-prism/` 目录 COPY 进镜像（或 `RUN git clone && cmake --build`），Dockerfile 见 §4.2。
- **不要**在镜像里 `apt install llama.cpp`：发行版包是上游版本，跑不了 PTQ1_0。

### 5.3 显存分配建议（8GB）

| 项 | 取值 | 说明 |
| --- | --- | --- |
| 权重 | 5,946,648,928 B（≈5.54 GiB） | PTQ1_0 |
| KV cache | `-ctk q8_0 -ctv q8_0`，16384 ctx | 实测总显存 7,674 MiB |
| GMU/批 | `-fa on`，batch 默认 | 再抬 batch 会顶显存 |
| 余量 | ~480 MiB | 只能跑单副本、单槽 |
| 提速 | `-ngl 99`、`-fa on` | 已验证 decode 43–44 tok/s |

**多模态在 8GB 上已实测可行**（2026-11-08）：`--mmproj <Q8_0.gguf> --no-mmproj-offload` ⇒ 视觉塔留在 CPU（不占显存），显存 7352/8151 MiB（比纯文本只多 ~250 MiB，来自视觉 API 侧的少量缓冲）、纯文本 decode/首字零回归；`/props` 的 `modalities.vision=true`。

代价（如实记账）：单张图视觉编码在 CPU 上约 **14 s**，加 ~1100 prompt token ⇒ 单图轮次 16–28 s；要更快只能把 mmproj 放进 GPU，但 8GB 装不下（27B+KV 已 7.6GB），得换 ≥16GB 卡。

### 5.4 LLMpod 部署切换

1. 模型管理里登记 Bonsai GGUF（路径/上传）。
2. 新建部署：镜像 = §4.2 的 `llama-prism:prism-b12128`；启动参数同上；副本 1、ctx 16384。
3. 切流：网关或应用侧把 `model` 从旧模型改为 `bonsai-2-27b`；`bonsai-workbench` 的 `llamacpp.host` 指向网关、`autostart:false`。
4. 观察 10 分钟：TTFT、tok/s、显存、5xx、OOM 重启次数。

## 6. 验证清单

| 类别 | 检查项 | 通过标准 |
| --- | --- | --- |
| 功能 | 普通对话 | 200，内容通顺，非乱码（PTQ1 误用上游运行时会出现乱码/加载失败） |
| 功能 | 工具调用 | 模型能产出 `tool_calls` 或可解析的文本调用；执行结果回填后能继续 |
| 功能 | 长上下文 | 8k/16k 输入不截断不报 `exceed_context_size_error` |
| 功能 | 多模态 | `POST /v1/chat/completions` 带 `image_url` data URL 返回 200，回答能读出图内文字；`/props` 的 `modalities.vision` 为 true |
| 性能 | 视觉编码 | 8GB/CPU offload 基线：单图 ~14 s 编码、轮次 16–28 s（换 ≥16GB 卡可 GPU 编码） |
| 性能 | TTFT / 首答 | 8GB 基线：首字/首答 ~0.3–5s（随 prefill 长度） |
| 性能 | decode | ≥40 tok/s（基线 43–44） |
| 性能 | prefill | 单槽 ≥500 tok/s（默认 4 槽并发会掉到 20+） |
| 显存 | `nvidia-smi` | <8GB，无 OOM/重启 |
| 端点 | `/v1/models`、`/props`、`/v1/chat/completions` | 均 200，ctx 与配置一致 |
| 平台 | 部署状态、副本 Ready、健康检查 | Running / 1/1 / 连续 10 分钟无重启 |
| 应用 | `bonsai-workbench` smoke / live / 带图 live / UI | 89/0、19/0、VISION_LIVE PASS、35/0 |
| 回滚条件 | 出现以下任一即回滚 | 加载失败/乱码、显存 OOM、token/s < 20、5xx > 1%、工具调用不可用 |

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 平台默认镜像不含 PrismML patch | 部署直接加载失败 | 主路径走自定义镜像；先在本地验证镜像可跑 |
| LLMpod 不支持自定义镜像（需确认） | 无法在平台内跑 Bonsai | 退回「外部端点」：平台只做网关/发布，推理仍由独立 llama-server 提供 |
| 8GB 显存 | 多副本/更大 ctx 不可行 | 单副本 16384；多模态用 CPU offload 绕开（代价单图 ~14s）；要并发或更快视觉需换 ≥16GB 卡 |
| 无 Linux GPU 主机（已发生） | LLMpod 无法在本机部署 | 当前走 B2 本机直连；真要平台化就租云 GPU Linux 主机（§4.0），本机不装 |
| 权重/仓库地址变化（需确认） | 构建不可复现 | 固定 commit + sha256 + 镜像 tag，全落版本库 |
| 工具调用协议差异 | agent 工具轮失败 | 用 `bonsai-workbench` 的 smoke/live 探针做准入 |
| 并发请求抢槽 | 延迟劣化到 60s+ | `-np 1` 单槽；多客户端用多副本/队列 |
| 回滚 | — | **不删 Ollama**：回滚 = 应用切回 `ollama-workbench`(4788)，LLMpod 侧保留上一部署版本一键回退；配置文件与镜像 tag 都留旧版本 |

回滚步骤（LLMpod 内）：把流量切回旧部署 → 确认 `/v1/models` 返回旧模型 → 应用 `llamacpp.host` 指回旧网关/本机 llama-server → 复跑 smoke/live。

## 8. 最终交付物

### 8.1 命令清单（环境已标注）

```powershell
# Windows：本机直连
& 'D:\llm\runtime\llama-prism-b12128-d7b2896-bin-win-cuda-13.3-x64\llama-server.exe' `
  -m 'D:\llm\models\bonsai-2-27b\Ternary-Bonsai-2-27B-PTQ1_0.gguf' `
  --mmproj 'D:\llm\models\bonsai-2-27b\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf' --no-mmproj-offload `
  -ngl 99 -fa on -c 16384 -ctk q8_0 -ctv q8_0 --jinja -np 1 -a bonsai-2-27b `
  --host 127.0.0.1 --port 8082
# Windows：应用
cd C:\Users\ZXP23\Documents\deepseek-harness\default-workspace\bonsai-workbench
node server.mjs          # http://127.0.0.1:4790
```

```bash
# Linux：镜像构建
docker build -t registry.example.com/bonsai/llama-prism:prism-b12128 -f Dockerfile .
docker push registry.example.com/bonsai/llama-prism:prism-b12128
# Linux：容器冒烟（绕过平台先验镜像；-v 挂载目录里要同时有 GGUF 与 mmproj）
docker run --gpus all --rm -p 8082:8082 \
  -v /data/models:/models:ro \
  registry.example.com/bonsai/llama-prism:prism-b12128
```

### 8.2 配置片段（bonsai-workbench）

```jsonc
{
  "model": "llama/bonsai-2-27b",
  "think": false,
  "permission": "workspace-write",
  "llamacpp": {
    "host": "http://<llmpod-gateway>:8090",   // 本机直连时改 127.0.0.1:8082
    "autostart": false,                        // 平台托管时 false
    "serverPath": "", "modelPath": "", "cudartPath": "",
    "mmproj": "",                               // 远端网关模式留空（视觉由服务端加载）；本机托管填 mmproj GGUF 路径
    "extraArgs": "",                           // 平台侧配置；本机托管时写 -ngl 99 ... -np 1
    "alias": "bonsai-2-27b"
  }
}
```

### 8.3 LLMpod 配置项清单

| 配置项 | 值 |
| --- | --- |
| 模型名 | `bonsai-2-27b` |
| 模型文件 | `Ternary-Bonsai-2-27B-PTQ1_0.gguf`（sha256 `53107f53…33ee3`） |
| 视觉塔 | `Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf`（629,246,976 B；必须 `--no-mmproj-offload`） |
| 引擎 | llama.cpp |
| 镜像 | 自定义：`llama-prism:prism-b12128`（基于 PrismML 分支） |
| 启动参数 | `--mmproj /models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf --no-mmproj-offload -ngl 99 -fa on -c 16384 -ctk q8_0 -ctv q8_0 --jinja -np 1 -a bonsai-2-27b --host 0.0.0.0 --port 8082` |
| 副本数 | 1 |
| 上下文长度 | 16384 |
| GPU | 单卡 ≥8GB（实测 7,674 MiB） |
| 健康检查 | `GET /v1/models`，10s 间隔，3 次失败重启 |
| 网关端口 | 8090（**需确认**实际部署） |

### 8.4 验收产物

- `bonsai-workbench`：README、`docs/UI设计说明.md`、smoke 89/0、live probe 19/0、带图 live probe（VISION_LIVE PASS）、UI probe 35/0 与截图（`ui-bonsai-vision.png` 为带图轮次）；
- 迁移侧：自定义镜像 Dockerfile + tag、LLMpod 部署 JSON/控制台截图、`/v1/models` 与 `/props` 回执、`nvidia-smi` 采样、回滚演练记录。

---

**这条线隔离**：本方案的所有组件（llama.cpp 运行时、LLMpod 部署、Bonsai 权重、bonsai-workbench 数据目录 `~/.bonsai-workbench`、端口 4790/8082）与 Ollama 线（`~/.ollama/models`、端口 4788、`ollama-workbench`）互不引用；Ollama 仅作为回滚时的只读资产保留。
