import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Bonsai 工作台 —— 独立的一条线：只连 llama.cpp / LLMpod 的 OpenAI 兼容 /v1。
 *
 * 与 Ollama 线彻底分开：不读 Ollama 的模型、不调 /api/chat、不依赖 /api/embed。
 * 数据也独立：默认 ~/.bonsai-workbench（会话、run 存档、插件、回执），
 * 与 Ollama 工作台的 ~/.ollama-workbench 互不相干。
 */
export const DATA_DIR = process.env.BW_DATA || path.join(os.homedir(), '.bonsai-workbench');
export const SESSION_DIR = path.join(DATA_DIR, 'sessions');
export const RUN_DIR = path.join(DATA_DIR, 'runs');
export const RECEIPT_DIR = process.env.BW_RECEIPT_DIR || path.join(DATA_DIR, 'receipts');
// BW_CONFIG 指向另一份配置：桌面快捷方式用它固定端点与模型，不改默认 <DATA_DIR>/config.json
const CFG_FILE = process.env.BW_CONFIG
  ? path.resolve(process.env.BW_CONFIG)
  : path.join(DATA_DIR, 'config.json');

export const DEFAULTS = {
  model: '',
  think: false,
  permission: 'workspace-write', // read-only | workspace-write | full-access
  approval: 'auto', // auto | ask
  workspace: '',
  maxSteps: 24,
  temperature: 0.6,
  tokenSaver: {
    toolOutputMaxChars: 8000,
    toolOutputMaxLines: 200,
    historyBudgetChars: 48000,
    compactSchema: true,
  },
  mcpServers: {},
  agentsEnabled: true,
  maxAgents: 4,
  durable: true,
  webSearch: true,
  webSearchCount: 8,
  // 搜索后端：auto = 记住上次成功的后端优先（实测本机只有 Bing 通，
  // DDG 每次必超时 10 s，auto 下 DDG 只用 6 s 短超时兜底）；也可显式锁定一个。
  webSearchEngine: 'auto', // auto | bing | duckduckgo
  pluginsEnabled: true,
  skillsEnabled: true,
  skillsDirs: [],
  skillsInjectMaxChars: 6000,
  // llama.cpp 端点。两种用法：
  //   本机托管：serverPath/modelPath 给了 + autostart=true ⇒ 工作台自己拉起 llama-server
  //   外部端点：只给 host（例如 LLMpod 网关 http://<gw>:8090/v1 的根），工作台不进程管理
  llamacpp: {
    enabled: true,
    // 端点模式：external = 连别人起的 OpenAI 兼容端点（如 D:\llm\ada 的 8080）；
    // managed = 工作台自己拉起 llama-server。一键切换（设置 →「应用模式」）只把
    // profiles[mode] 里的字段写进当前配置，其它设置一律不动。
    // 默认值沿用托管口径（host 8082 + autostart）；本机实际用 external（见 bonsai.config.json）。
    mode: 'managed',
    profiles: {
      external: {
        host: 'http://127.0.0.1:8080',
        autostart: false,
        serverPath: '',
        modelPath: '',
        mmproj: '',
        cudartPath: '',
        extraArgs: '',
        alias: 'bonsai-2-27b',
        apiKey: '',
        apiKeyFile: 'D:\\llm\\ada\\repo\\artifacts\\api_key.txt',
      },
      managed: {
        host: 'http://127.0.0.1:8082',
        autostart: true,
        serverPath: 'D:\\llm\\runtime\\llama-prism-b12128-d7b2896-bin-win-cuda-13.3-x64\\llama-server.exe',
        modelPath: 'D:\\llm\\models\\bonsai-2-27b\\Ternary-Bonsai-2-27B-PTQ1_0.gguf',
        mmproj: 'D:\\llm\\models\\bonsai-2-27b\\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
        cudartPath: 'D:\\llm\\runtime\\cudart-llama-bin-win-cuda-13.3-x64',
        extraArgs: '-ngl 99 -fa on -c 16384 -ctk q8_0 -ctv q8_0 --jinja -np 1',
        alias: 'bonsai-2-27b',
        apiKey: '',
        apiKeyFile: '',
      },
    },
    host: 'http://127.0.0.1:8082',
    autostart: true,
    serverPath: '',
    modelPath: '',
    // 多模态：mmproj 与主模型成对。给了就随服务端参数加载，且强制放在 CPU
    // （--no-mmproj-offload）：27B + 16k 上下文已占 7.3/8.1 GB，mmproj 上 GPU 会 OOM，
    // 放 CPU 只慢视觉编码（实测约 14 s/张），文本路径零回归。
    mmproj: '',
    cudartPath: '',
    extraArgs: '-ngl 99 -fa on -c 16384 -ctk q8_0 -ctv q8_0 --jinja -np 1',
    alias: '',
    // 外部端点要鉴权时给一个：apiKey 直接写值，apiKeyFile 指向 key 文件（llama-server --api-key）
    apiKey: '',
    apiKeyFile: '',
    startTimeoutMs: 180000,
  },
  // RAG：本地知识库检索（BM25 词法，零依赖零显存）。回答前自动检索并注入资料，
  // 要求模型带 [S#] 引用，回答后做引用校验——这是「减少幻觉」的承重设计。
  rag: {
    enabled: true,
    autoRetrieve: true,
    citeRequired: true,
    root: '', // 空 = 用 workspace
    topK: 6,
    maxChars: 5200,
    chunkSize: 700,
    overlap: 120,
    minSize: 200,
    maxFiles: 1500,
    maxChunks: 5000,
    maxFileBytes: 1500000,
    include: [],
  },
  // 上下文压缩：历史超阈值时用模型把旧消息摘要成一段；原始消息仍保留在会话里，
  // 只是不再全量发给模型（摘要 + 最近 keepRecent 条）。
  ctx: {
    enabled: true,
    ratio: 0.72,
    keepRecent: 10,
    summaryChars: 1200,
    maxSourceChars: 14000,
    minMessages: 8,
  },
  // 思考路径（PSV：计划 → 取证 → 作答 → 自检）。planCall=true 时开跑前多一次小调用出计划；
  // 失败自动退回确定性计划，阶段本身不会缺席。
  thinking: {
    enabled: true,
    planCall: true,
    maxPlanSteps: 5,
    planMaxTokens: 180,
    planTimeoutMs: 30000,
    requireSelfCheck: false, // true = 最终答复缺「自检：」段就重写一次（更严格，也更啰嗦）
  },
  // 记忆分层：五层（user/memory/key/project/daily），前三层自动注入 system。
  // 注入成本按层截断 + 总长封顶；空记忆不花任何 token。daily=true 时每次 run 结束
  // 自动往当天日志追加一条（不调模型、纯记账）。
  memory: {
    enabled: true,
    injectMaxChars: 2200,
    userMaxChars: 500,
    memoryMaxChars: 700,
    keyMaxChars: 900,
    daily: true,
    injectProject: false,
  },
  // 回执报告：每次 run 结束由主流程强制写 <数据目录>/receipts/<runId>.{md,json}。
  // enabled=false 只建议测试用——关掉就破坏了「每次结束必有回执」这条承诺。
  receipt: {
    enabled: true,
  },
};

let cache = null;

function merge(a, b) {
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      a[k] = merge(a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? a[k] : {}, v);
    } else {
      a[k] = v;
    }
  }
  return a;
}

export function ensureDirs() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
}

export function loadConfig() {
  if (cache) return cache;
  ensureDirs();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  } catch {
    raw = {};
  }
  cache = merge(structuredClone(DEFAULTS), raw);
  if (!cache.workspace) cache.workspace = process.env.BW_WORKSPACE || process.cwd();
  return cache;
}

export function saveConfig(patch) {
  const cur = loadConfig();
  const p = patch || {};
  // mcpServers 整体替换：深合并会让界面上删掉的服务器留在配置里
  if (Object.prototype.hasOwnProperty.call(p, 'mcpServers')) cur.mcpServers = {};
  merge(cur, p);
  fs.writeFileSync(CFG_FILE, JSON.stringify(cur, null, 2), 'utf8');
  return cur;
}

export function configFile() {
  return CFG_FILE;
}
