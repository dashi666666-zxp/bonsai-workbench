import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, DATA_DIR } from './config.mjs';

/**
 * 第二个后端：llama.cpp 的 OpenAI 兼容 /v1。
 *
 * 为什么需要它：三值权重量化（PrismML PTQ1_0 / PQ2_0）只有 PrismML 那份 llama.cpp
 * 能加载——Ollama 和上游 llama.cpp 都直接 llama_model_load: bad allocation。
 * 27B 模型 5.5 GiB，上下文按 8 GB 卡实测给 16384（q8_0 KV，显存约 7.6/8.1 GB）。
 * 请求超过 n_ctx 时 llama.cpp 直接 400，故发前按 /props 的 n_ctx 裁历史（见 fitMessages）。
 *
 * 模型名前缀 "llama/" 表示走这个后端，其余仍走 Ollama。接口差异在这一层吃掉：
 *   请求  Ollama /api/chat 形状  → OpenAI /v1/chat/completions 形状
 *         （num_ctx / keep_alive / think 这类 Ollama 专有参数丢弃，上下文由 llama-server 启动参数决定）
 *   响应  OpenAI SSE 增量        → Ollama /api/chat 的 chunk 形状
 *         （message.content / message.thinking / message.tool_calls / done + 计数）
 * 这样 model/agent.mjs 一行都不用改。
 */

export const PREFIX = 'llama/';

let logFd = null;
let proc = null;
let starting = null;
let lastError = '';
let lastStop = 0;

function c() {
  return loadConfig().llamacpp || {};
}

export function isLlamaModel(name) {
  return String(name || '').startsWith(PREFIX);
}

export function base() {
  return String(c().host || 'http://127.0.0.1:8082').replace(/\/+$/, '');
}

/** 模型 id → 显示名：全路径取文件名去 .gguf；端点设了 alias 就直接用 id */
export function displayName(id) {
  const s = String(id || '');
  const alias = String(c().alias || '').trim();
  if (alias && s === alias) return alias;
  const tail = s.replace(/\\/g, '/').split('/').pop() || s;
  return tail.replace(/\.gguf$/i, '');
}

function modelId(name) {
  return String(name || '').slice(PREFIX.length);
}

// ---- 鉴权 ----
// 外部端点（如 D:\llm\ada 的 bonsai-server，llama-server --api-key）会对所有 /v1 请求要 Bearer。
// 两种给法：apiKey 直接写值；apiKeyFile 指向 key 文件（推荐——key 由服务端生成、随服务重启不变）。
let keyCache = { path: '', mtimeMs: 0, value: '' };

export function apiKey() {
  const cfg = c();
  const direct = String(cfg.apiKey || '').trim();
  if (direct) return direct;
  const file = String(cfg.apiKeyFile || '').trim();
  if (!file) return '';
  try {
    const st = fs.statSync(file);
    if (keyCache.path === file && keyCache.mtimeMs === st.mtimeMs) return keyCache.value;
    const value = fs.readFileSync(file, 'utf8').trim();
    keyCache = { path: file, mtimeMs: st.mtimeMs, value };
    return value;
  } catch {
    return '';
  }
}

function withAuth(headers) {
  const key = apiKey();
  const out = { ...(headers || {}) };
  if (key) out.authorization = `Bearer ${key}`;
  return out;
}

async function getJson(pathname, ms = 4000, init = {}) {
  const res = await fetch(base() + pathname, {
    ...init,
    headers: withAuth(init.headers),
    signal: AbortSignal.timeout(ms),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`llama.cpp ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`llama.cpp ${pathname} 返回非 JSON: ${text.slice(0, 200)}`);
  }
}

export async function probe(ms = 1500) {
  try {
    await getJson('/v1/models', ms);
    return true;
  } catch {
    return false;
  }
}

// ---- 模型与能力 ----

const capsCache = new Map();

/**
 * /props 的 chat_template 里带 tools 才认工具调用能力；n_ctx 是启动时给的上下文；
 * modalities.vision 只在挂了 mmproj 时为 true（图像走 OpenAI content 数组）。
 */
async function props() {
  try {
    const p = await getJson('/props', 4000);
    return {
      nCtx: Number(p.default_generation_settings?.n_ctx) || 0,
      tools: String(p.chat_template || '').includes('tools'),
      vision: Boolean(p.modalities?.vision),
      modelPath: String(p.model_path || ''),
    };
  } catch {
    return { nCtx: 0, tools: false, vision: false, modelPath: '' };
  }
}

/** llama.cpp 没有 /api/show 那种能力表，能力全从 /props 推 */
function capsOf(info) {
  const caps = [];
  if (info.tools) caps.push('tools');
  if (info.vision) caps.push('vision');
  return caps;
}

let ctxCache = { at: 0, n: 0 };

/** llama-server 当前上下文（/props 的 n_ctx），缓存 30s；拉不起来就返回 0（不裁剪） */
export async function ctxSize() {
  if (Date.now() - ctxCache.at < 30000 && ctxCache.n) return ctxCache.n;
  const info = await props();
  ctxCache = { at: Date.now(), n: info.nCtx };
  return info.nCtx;
}

// 粗估 token：ASCII 约 2.8 字符/token（JSON/路径/标点实际比 4 更差，按 2.8 保守估），
// CJK 约 1 字/token（宁多勿少，多裁一点比 400 好）。曾按 3.5 估，结果 17.3k 请求被
// llama.cpp 以「exceeds the available context size」拒掉，逼近满上下文还会触发 server 内部
// bad allocation（server-context.cpp:3560 GGML_ASSERT），所以必须留足余量。
export function estTokens(text) {
  let ascii = 0;
  let wide = 0;
  for (const ch of String(text ?? '')) {
    if (ch.codePointAt(0) < 0x2e80) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 2.8) + wide;
}

function messageTokens(m) {
  let n = 6;
  if (Array.isArray(m.content)) {
    for (const p of m.content) {
      if (p?.type === 'image_url') n += IMAGE_TOKENS;
      else if (p?.type === 'text') n += estTokens(p.text);
    }
  } else {
    n += estTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
  }
  if (Array.isArray(m.images)) n += m.images.filter(isImageDataUrl).length * IMAGE_TOKENS;
  if (m.tool_calls) n += estTokens(JSON.stringify(m.tool_calls));
  if (m.tool_call_id) n += estTokens(m.tool_call_id);
  return n;
}

/**
 * 把消息裁到上下文能装下：system 永远保留，历史从最老的 user 消息边界整段丢弃
 * （切在 user 上才不会拆散 assistant.tool_calls 与 tool 回执的配对）。
 * ratio 越小裁得越狠；返回 [messages, 是否裁过]。
 */
export function fitMessages(messages, ctx, toolsJson = '', ratio = 1) {
  const budget = Math.floor(ctx * ratio) - 1000 - estTokens(toolsJson);
  if (!Array.isArray(messages) || !messages.length || budget <= 0) return [messages, false];
  const costs = messages.map(messageTokens);
  const total = costs.reduce((a, b) => a + b, 0);
  if (total <= budget) return [messages, false];
  const head = messages[0]?.role === 'system' ? 1 : 0;
  const sysMsgs = messages.slice(0, head);
  const sysCost = costs.slice(0, head).reduce((a, b) => a + b, 0);

  // 锚点＝最后一条 user 消息。Bonsai 的 jinja 模板缺 user 会直接 500
  // 「Jinja Exception: No user query found in messages.」——旧实现只在 user 边界切，
  // 单 user 会话（agent 工具循环就是这种）永远找不到切点，落进「system+最后一条」分支 ⇒ 必炸。
  let lastUser = -1;
  for (let i = messages.length - 1; i >= head; i--) {
    if (messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) {
    const last = { ...messages[messages.length - 1] };
    const keep = Math.max(0, Math.floor(budget * 1.2));
    // content 可能是带图的数组：先退回纯文本（图占 ~1100 token，这里已经装不下了）
    const text = textOfContent(last.content);
    if (text.length > keep) {
      last.content = text.slice(0, keep) + '\n…（上下文超限，已截断）';
    } else {
      last.content = text;
    }
    return [sysMsgs.concat(last), true];
  }

  // 从 lastUser 起按「工具轮」分组：user 自己一组；assistant(tool_calls)+紧随的 tool 一组；其余单条一组。
  // 只允许整组丢（丢一半会留下孤儿 tool_calls / 孤儿 tool 回执，llama.cpp 直接报错）。
  const groups = [[lastUser]];
  for (let i = lastUser + 1; i < messages.length; i++) {
    const cur = groups[groups.length - 1];
    const starter = messages[cur[0]];
    const starterTools = starter.role === 'assistant' && Array.isArray(starter.tool_calls) && starter.tool_calls.length > 0;
    if (messages[i].role === 'tool' && starterTools) cur.push(i);
    else groups.push([i]);
  }
  const costOf = (g) => g.reduce((n, i) => n + costs[i], 0);

  // user 组永远保留；其后从最新一组往前塞，塞不下的整组丢
  let keepFrom = groups.length;
  let used = sysCost + costOf(groups[0]);
  for (let g = groups.length - 1; g >= 1; g--) {
    const c = costOf(groups[g]);
    if (used + c > budget) break;
    used += c;
    keepFrom = g;
  }
  const kept = [groups[0]].concat(groups.slice(Math.max(keepFrom, 1)));

  // user 单独一组都装不下：先丢图（每张 ~1100 token），再截断正文
  // （宁可少几个字，也不能把 user 丢出去）
  if (used > budget) {
    const anchor = { ...messages[lastUser] };
    const room = Math.max(0, budget - sysCost - 16);
    const text = textOfContent(anchor.content);
    anchor.content = estTokens(text) > room ? text.slice(0, Math.max(0, room * 3)) + '\n…（上下文超限，已截断）' : text;
    console.error(`[fit] 历史超限：预算 ${budget}，已截断 user 提示（图片已丢弃）`);
    return [sysMsgs.concat([anchor]), true];
  }
  console.error(
    `[fit] 历史超限：预算 ${budget}，丢弃 ${groups.length - kept.length} 组旧消息（${total} → ${used}）`,
  );
  return [sysMsgs.concat(kept.flat().map((i) => messages[i])), true];
}

export async function listModels() {
  const data = await getJson('/v1/models', 4000);
  const info = await props();
  return (data.data || []).map((m) => ({
    name: PREFIX + displayName(m.id),
    size: 0,
    params: '',
    quant: '',
    family: 'llama.cpp',
    source: 'llamacpp',
    contextLength: info.nCtx,
    caps: capsOf(info),
  }));
}

/** llama-server 一次只装一个模型，起来就是常驻 */
export async function listLoaded() {
  if (!(await probe(1200))) return [];
  const info = await props();
  const models = await listModels();
  return models.map((m) => ({ name: m.name, vram: 0, ctx: info.nCtx, expiresAt: '', loaded: true }));
}

export async function modelCaps(name) {
  const key = String(name || '');
  if (capsCache.has(key)) return capsCache.get(key);
  const info = await props();
  const caps = { caps: capsOf(info), contextLength: info.nCtx };
  capsCache.set(key, caps);
  return caps;
}

export function forgetModelCaps(name) {
  capsCache.delete(String(name || ''));
}

export function clearCapsCache() {
  capsCache.clear();
}

// ---- 消息与用量转换 ----

/** 一张图在 llama.cpp 里约 1024 个视觉 token（外加分隔），按 1100 估，宁多勿少 */
export const IMAGE_TOKENS = 1100;

export function isImageDataUrl(s) {
  return typeof s === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(s);
}

/** 有图就走 OpenAI content 数组；没有图仍是字符串（llama.cpp 两种都吃） */
function contentOf(m) {
  const text = String(m.content ?? '');
  const imgs = Array.isArray(m.images) ? m.images.filter(isImageDataUrl) : [];
  if (!imgs.length) return text;
  return [
    { type: 'text', text: text || '（见图片）' },
    ...imgs.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

/** content 数组取回纯文本（裁上下文时用：先丢图，再截文本） */
function textOfContent(content) {
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .filter((p) => p?.type === 'text')
    .map((p) => p.text || '')
    .join('\n');
}

/**
 * session 消息 → OpenAI 消息。
 * 关键差别：Ollama 的 tool 消息只带 tool_name，OpenAI 要 tool_call_id；
 * 按「上一条 assistant 的 tool_calls 顺序」配对（agent.mjs 就是按顺序追加的）。
 * 用户的 images（data URL 数组）转成 content 数组里的 image_url 部分。
 */
export function toOpenAIMessages(msgs) {
  const out = [];
  let pending = [];
  for (const m of msgs || []) {
    if (m.role === 'tool') {
      const id = pending.shift() || `call_${out.length}`;
      out.push({ role: 'tool', tool_call_id: id, content: String(m.content ?? '') });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length && !m.fromText) {
      pending = m.tool_calls.map((tc, i) => tc.id || `call_${i}`);
      out.push({
        role: 'assistant',
        content: String(m.content ?? ''),
        tool_calls: m.tool_calls.map((tc, i) => ({
          id: pending[i],
          type: 'function',
          function: {
            name: tc.function?.name || tc.name || '',
            arguments:
              typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || tc.args || {}),
          },
        })),
      });
      continue;
    }
    pending = [];
    out.push({ role: m.role === 'system' ? 'system' : 'user', content: contentOf(m) });
  }
  return out;
}

/** llama.cpp 结尾片给 timings（毫秒），Ollama chunk 要纳秒 */
export function toOllamaUsage(t) {
  const promptMs = Number(t?.prompt_ms) || 0;
  const predMs = Number(t?.predicted_ms) || 0;
  return {
    prompt_eval_count: Number(t?.prompt_n) || 0,
    eval_count: Number(t?.predicted_n) || 0,
    eval_duration: Math.round(predMs * 1e6),
    total_duration: Math.round((promptMs + predMs) * 1e6),
  };
}

// ---- 流式调用 ----

function requestBody(body) {
  const temp = Number(body?.options?.temperature);
  const out = {
    model: modelId(body.model),
    messages: toOpenAIMessages(body.messages),
    stream: true,
    temperature: Number.isFinite(temp) && temp >= 0 ? temp : 0.6,
  };
  if (Array.isArray(body.tools) && body.tools.length) out.tools = body.tools;
  if (Number(body.max_tokens) > 0) out.max_tokens = Number(body.max_tokens);
  // 思考开关要交给 chat template（Qwen3 系模板的 enable_thinking）。不给就一直按模板默认「开」，
  // Bonsai 2 27B 会一路想到 4096 上下文用尽，直接报 Context size has been exceeded。
  if (typeof body?.think === 'boolean') out.chat_template_kwargs = { enable_thinking: body.think };
  return out;
}

async function postStream(body, signal, ratio = 1) {
  const payload = requestBody(body);
  const ctx = await ctxSize().catch(() => 0);
  if (ctx) {
    const toolsJson = payload.tools ? JSON.stringify(payload.tools) : '';
    const [msgs, trimmed] = fitMessages(payload.messages, ctx, toolsJson, ratio);
    if (trimmed) {
      payload.messages = msgs;
      console.error(`  llama.cpp 上下文 ${ctx}，历史过长已从最老处裁剪（保留 ${msgs.length} 条消息）`);
    }
    // 生成也要留额度：思考一路吃到 n_ctx 时 llama.cpp 会在流中途直接报 Context size has been exceeded
    const used = msgs.reduce((n, m) => n + messageTokens(m), 0) + estTokens(toolsJson);
    const cap = ctx - used - 64;
    if (cap > 0) payload.max_tokens = payload.max_tokens ? Math.min(payload.max_tokens, cap) : cap;
  }
  return fetch(base() + '/v1/chat/completions', {
    method: 'POST',
    headers: withAuth({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
    signal,
  });
}

/**
 * 流式调用，yield 成 Ollama /api/chat 的 chunk 形状。
 * 工具调用分片（index 在 tool_call 顶层）直接透传 arguments 字符串，
 * agent.mjs 的 mergeStreamedCalls 会按 index 累加并 JSON.parse。
 */
export async function* chatStream(body, signal) {
  let res;
  try {
    res = await postStream(body, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    // 端点没起：配置了就拉起来再试一次
    const r = await ensureServer();
    if (!r.ok) throw new Error(`llama.cpp 端点不可用（${base()}）：${r.reason || e?.message || e}`);
    res = await postStream(body, signal);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // 估算偏小或历史在流式之外涨了：按一半上下文再狠裁一次
    if (res.status === 400 && /exceed_context_size|exceeds the available context|Context size has been exceeded/i.test(t)) {
      res = await postStream(body, signal, 0.5);
      if (!res.ok) {
        const t2 = await res.text().catch(() => '');
        throw new Error(`llama.cpp ${res.status}: ${t2.slice(0, 600)}`);
      }
    } else {
      throw new Error(`llama.cpp ${res.status}: ${t.slice(0, 600)}`);
    }
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj.error) throw new Error(String(obj.error.message || obj.error));
      if (obj.timings) usage = toOllamaUsage(obj.timings);
      const ch = obj.choices?.[0];
      if (!ch) {
        if (obj.usage) {
          usage = {
            prompt_eval_count: Number(obj.usage.prompt_tokens) || 0,
            eval_count: Number(obj.usage.completion_tokens) || 0,
            eval_duration: 0,
            total_duration: 0,
          };
        }
        continue;
      }
      const d = ch.delta || {};
      const msg = {};
      if (d.content) msg.content = d.content;
      if (d.reasoning_content) msg.thinking = d.reasoning_content;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
        msg.tool_calls = d.tool_calls.map((tc, i) => ({
          id: tc.id,
          function: {
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '',
            index: Number.isInteger(tc.index) ? tc.index : i,
          },
        }));
      }
      if (msg.content || msg.thinking || msg.tool_calls) yield { message: msg, done: false };
    }
  }
  if (buf.trim().startsWith('data:')) {
    const tail = buf.trim().slice(5).trim();
    if (tail && tail !== '[DONE]') {
      try {
        const obj = JSON.parse(tail);
        if (obj.timings) usage = toOllamaUsage(obj.timings);
      } catch {
        /* 残片忽略 */
      }
    }
  }
  yield usage ? { message: {}, done: true, ...usage } : { message: {}, done: true };
}

// ---- 进程管理 ----

function tailLog(n = 700) {
  try {
    const s = fs.readFileSync(path.join(DATA_DIR, 'llama-server.log'), 'utf8');
    return s.slice(-n).trim();
  } catch {
    return '';
  }
}

function splitArgs(s) {
  return String(s || '')
    .match(/"[^"]*"|\S+/g)
    ?.map((x) => x.replace(/^"|"$/g, ''))
    .filter(Boolean) || [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 多模态启动参数：--mmproj 顺手把 mmproj 挂上；--no-mmproj-offload 强制它在 CPU。
 * 8 GB 卡上 27B + 16k q8_0 KV 已占 7.3/8.1 GB，mmproj（630 MB）上 GPU 必 OOM；
 * 放 CPU 的代价只有视觉编码（实测 ~14 s/张），文本路径零影响。
 */
export function mmprojArgs(cfg) {
  const mmproj = String(cfg?.mmproj || '').trim();
  return mmproj ? ['--mmproj', mmproj, '--no-mmproj-offload'] : [];
}

async function startServer(timeoutMs = 0) {
  const cfg = c();
  const exe = String(cfg.serverPath || '').trim();
  const model = String(cfg.modelPath || '').trim();
  const mmproj = String(cfg.mmproj || '').trim();
  if (!exe) return { ok: false, reason: '未配置 llama-server 路径（设置 → 本地大模型）' };
  if (!model) return { ok: false, reason: '未配置模型 .gguf 路径（设置 → 本地大模型）' };
  if (!fs.existsSync(exe)) return { ok: false, reason: `llama-server 不存在：${exe}` };
  if (!fs.existsSync(model)) return { ok: false, reason: `模型不存在：${model}` };
  if (mmproj && !fs.existsSync(mmproj)) return { ok: false, reason: `mmproj 不存在：${mmproj}` };

  const u = new URL(base());
  const alias = String(cfg.alias || '').trim() || displayName(model);
  const args = [
    '-m',
    model,
    '--host',
    u.hostname,
    '--port',
    u.port || '8082',
    '-a',
    alias,
    ...mmprojArgs(cfg),
    ...splitArgs(cfg.extraArgs),
  ];
  const env = { ...process.env };
  const prepend = [cfg.cudartPath, cfg.cudaPath].map((x) => String(x || '').trim()).filter(Boolean);
  if (prepend.length) env.PATH = [...prepend, env.PATH || ''].join(path.delimiter);

  const logPath = path.join(DATA_DIR, 'llama-server.log');
  try {
    logFd = fs.openSync(logPath, 'w');
    fs.writeSync(logFd, `# ${new Date().toISOString()}\n# ${exe} ${args.join(' ')}\n`);
  } catch {
    logFd = null;
  }
  lastError = '';
  lastStop = 0;
  try {
    proc = spawn(exe, args, {
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      env,
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, reason: `启动失败：${e?.message || e}` };
  }
  const child = proc;
  child.on('error', (e) => {
    lastError = String(e?.message || e);
  });
  child.on('exit', (code) => {
    if (proc === child) proc = null;
    if (code && Date.now() - lastStop > 2000) lastError = `llama-server 退出 code=${code}：${tailLog(400)}`;
    try {
      if (logFd != null) fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
    logFd = null;
  });

  const timeout = Number(timeoutMs) || Number(cfg.startTimeoutMs) || 180000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { ok: false, reason: lastError || `llama-server 退出 code=${child.exitCode}：${tailLog(400)}` };
    }
    if (await probe(1200)) {
      clearCapsCache();
      return { ok: true, started: true, host: base(), pid: child.pid, alias };
    }
    await sleep(500);
  }
  return { ok: false, reason: `启动超时（${Math.round(timeout / 1000)}s），日志：${tailLog(500)}` };
}

/**
 * 确保端点在跑：已通就复用（可能是用户自己起的 server），不通且允许才自己拉。
 * opts.force = 手动点「启动」按钮，忽略 autostart 开关。
 */
export async function ensureServer(opts = {}) {
  const cfg = c();
  if (cfg.enabled === false && !opts.force) return { ok: false, reason: '未启用 llama.cpp 后端' };
  if (await probe(1200)) return { ok: true, already: true, host: base() };
  if (starting) return starting;
  if (!cfg.autostart && !opts.force) {
    return { ok: false, reason: `端点不通（${base()}）；开启「自动启动」或点「启动/连接」` };
  }
  starting = startServer(opts.timeoutMs).finally(() => {
    starting = null;
  });
  return starting;
}

export function stopServer() {
  if (!proc) return { ok: true, already: true };
  const child = proc;
  lastStop = Date.now();
  proc = null;
  try {
    child.kill('SIGKILL');
  } catch (e) {
    lastError = String(e?.message || e);
    return { ok: false, reason: lastError };
  }
  clearCapsCache();
  return { ok: true, pid: child.pid };
}

export function statusOf() {
  return {
    enabled: c().enabled !== false,
    mode: modeOf(),
    host: base(),
    managed: Boolean(proc && proc.exitCode === null),
    pid: proc && proc.exitCode === null ? proc.pid : 0,
    autostart: Boolean(c().autostart),
    modelPath: String(c().modelPath || ''),
    mmproj: String(c().mmproj || ''),
    serverPath: String(c().serverPath || ''),
    lastError,
  };
}

// ---- 端点模式一键切换 ----
// 两种模式只是两组字段：外部端点（别人的 /v1，工作台不进程管理）与本机托管
// （工作台自己拉起 llama-server）。切换只写 profiles[mode]，不碰模型/RAG/工具等设置。

export const MODES = ['external', 'managed'];

/** 当前模式：显式配置优先；老配置没 mode 时按「自启 + 两条路径都在」推断 */
export function modeOf(cfg = c()) {
  if (cfg.mode === 'external' || cfg.mode === 'managed') return cfg.mode;
  return cfg.autostart && cfg.serverPath && cfg.modelPath ? 'managed' : 'external';
}

const MODE_FIELDS = [
  'host',
  'autostart',
  'serverPath',
  'modelPath',
  'mmproj',
  'cudartPath',
  'extraArgs',
  'alias',
  'apiKey',
  'apiKeyFile',
];

/**
 * 一键切换端点模式。切到外部端点前先停掉自己拉起的 llama-server（释放显存）；
 * 切到托管模式会立刻尝试拉起，显存被外部服务占着时如实把失败原因带回界面。
 */
export async function switchMode(mode) {
  if (!MODES.includes(mode)) return { ok: false, reason: `未知的端点模式：${mode}` };
  const cfg = c();
  const profile = cfg.profiles?.[mode];
  if (!profile) return { ok: false, reason: `配置里没有 ${mode} 模式的预设（llamacpp.profiles.${mode}）` };

  if (mode === 'external') stopServer();

  const patch = { mode };
  for (const k of MODE_FIELDS) if (profile[k] !== undefined) patch[k] = profile[k];
  const next = saveConfig({ llamacpp: patch });
  clearCapsCache();
  ctxCache = { at: 0, n: 0 };

  const start = mode === 'managed' ? await ensureServer({ force: true, timeoutMs: 90000 }) : null;
  const up = await probe(1200).catch(() => false);
  // ok 只表示「模式已切过去、配置已落盘」；端点当下通不通看 up/reason。
  // 切到 external 时常是外部服务还没启（那是用户的事），不该当成切换失败。
  return {
    ok: true,
    mode: modeOf(next?.llamacpp),
    up,
    reason: up ? '' : String(start?.reason || '端点未响应：外部服务没起？或显存被别的 llama-server 占着'),
    start,
    status: statusOf(),
  };
}

// 工作台退出时别把 llama-server 留成孤儿
process.on('exit', () => {
  try {
    if (proc && proc.exitCode === null) proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
});
