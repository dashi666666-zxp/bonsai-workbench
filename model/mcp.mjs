/**
 * MCP 客户端：三种传输。
 *
 *  - stdio：换行分隔的 JSON-RPC 2.0，起一个本地子进程（本地 MCP 服务器的标准形态）
 *  - http ：Streamable HTTP。一条请求一条 POST；响应可能是 application/json，
 *           也可能是 text/event-stream（结果在 SSE 流里回来）。会话 id 走 Mcp-Session-Id 头。
 *  - sse  ：旧版 HTTP+SSE。先 GET 长连接，首个 event:endpoint 给出 POST 地址；
 *           之后请求 POST 过去，结果从同一条 SSE 流推回来。
 *
 * 只做 initialize / tools.list / tools.call 三件事；不引依赖，用 Node 自带的
 * fetch / ReadableStream / TextDecoder。
 *
 * 配置形态（config.json 的 mcpServers，一个名字一份 spec）：
 *   "本地":   { "command": "node", "args": ["server.mjs"], "env": {} }
 *   "远程":   { "type": "http", "url": "https://host/mcp", "headers": { "Authorization": "Bearer ${MCP_TOKEN}" } }
 *   "旧远程": { "type": "sse",  "url": "https://host/sse" }
 * 不给 type 时：有 command 按 stdio，只有 url 按 http。
 * headers / url 里的 ${ENV} 会从环境变量展开——密钥不必写进 config.json。
 *
 * 边界（有意不做）：不支持服务端发起的请求（sampling / roots / elicitation；我们
 * capabilities 是空的，收到就回 -32601），也不开 Streamable HTTP 的 GET 订阅流
 * （只做请求-响应，不订阅 notifications/tools/list_changed 这类推送）。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROTOCOL_VERSION = '2025-06-18';
/** 服务端回什么版本都收：三种版本的 JSON-RPC 层对我们是一样的 */
const INIT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 120000;
const NOTIFY_TIMEOUT_MS = 15000;
const NAME_SEP = '__';

/** 客户端版本号直接读 package.json，避免两处手改漂移 */
const CLIENT_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/* ================= 纯函数（可离线单测） ================= */

/** 把 ${ENV} 换成环境变量；没定义的保持原样 */
export function expandEnv(value) {
  return String(value ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => (process.env[k] !== undefined ? process.env[k] : m));
}

function kindOf(spec) {
  if (!spec || typeof spec !== 'object') return '';
  const t = String(spec.type || spec.transport || '').trim().toLowerCase();
  if (t === 'stdio') return 'stdio';
  if (t === 'http' || t === 'streamable-http' || t === 'streamablehttp') return 'http';
  if (t === 'sse') return 'sse';
  if (t) return '';
  if (spec.command) return 'stdio';
  if (spec.url) return 'http';
  return '';
}

/** 判传输类型；配置不完整就抛带人话的错误（syncMcp 会把它写进状态） */
export function mcpTransportOf(spec) {
  const kind = kindOf(spec);
  if (kind) {
    if (kind === 'stdio' && !spec.command) throw new Error('MCP stdio 传输缺少 command');
    if (kind !== 'stdio' && !spec.url) throw new Error(`MCP ${kind} 传输缺少 url`);
    return kind;
  }
  const declared = String(spec?.type || spec?.transport || '').trim();
  if (declared) throw new Error(`未知的 MCP 传输类型「${declared}」（支持 stdio / http / sse）`);
  throw new Error('MCP 配置缺少 command（stdio）或 url（http/sse）');
}

/** 配置指纹：变了才重连 */
export function mcpSpecKey(spec) {
  return JSON.stringify({
    k: kindOf(spec),
    c: spec?.command || '',
    a: spec?.args || [],
    e: spec?.env || {},
    u: spec?.url || '',
    h: spec?.headers || {},
  });
}

/**
 * 解析一个 SSE 事件块（不含结尾的空行）。
 * 返回 { event, data }；纯注释/心跳（没有 data 行）返回 null。
 */
export function parseSseEvent(raw) {
  let event = 'message';
  const data = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

/** 逐块读 SSE 流，每个事件调一次 onEvent；流结束/中断即返回 */
async function readSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const m = buf.match(/\r?\n\r?\n/);
        if (!m) break;
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseSseEvent(raw);
        if (ev) onEvent(ev);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/* ================= 客户端 ================= */

class McpClient {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.kind = mcpTransportOf(spec);
    this.protocolVersion = null;
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
    this.onFatal = null; // syncMcp 挂的回调：连接断掉时把状态改成 error
    // http / sse 用
    this.sessionId = null;
    this.postUrl = null;
    this.baseUrl = '';
    this.headers = {};
    this.aborts = new Set();
    this.endpointWait = null;
    this.endpointDone = null;
    this.endpointFail = null;
    this.streamTask = null;
  }

  async start() {
    if (this.kind === 'stdio') return this.startStdio();
    const url = String(this.spec.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`MCP ${this.name} 的 url 必须是 http:// 或 https://（拿到「${url}」）`);
    this.baseUrl = expandEnv(url);
    this.headers = {};
    if (this.spec.headers && typeof this.spec.headers === 'object') {
      for (const [k, v] of Object.entries(this.spec.headers)) this.headers[k] = expandEnv(v);
    }
    if (this.kind === 'sse') await this.openSseStream();
    // http：第一次 POST（initialize）时才算真正连上
  }

  /* ---------------- stdio ---------------- */

  startStdio() {
    const { command, args = [], env = {} } = this.spec;
    if (!command) throw new Error('缺少 command');

    const shell = process.platform === 'win32' && (/\.(cmd|bat)$/i.test(command) || !/[\\/]/.test(command));
    const quote = (s) => (/[\s"]/.test(s) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s));
    const useShell = shell && !/\.(js|mjs|cjs|exe)$/i.test(command);
    const line = useShell ? [quote(command), ...args.map(quote)].join(' ') : null;

    let child;
    try {
      child = useShell
        ? spawn(line, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } })
        : spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
    } catch (e) {
      throw this.friendlySpawnError(e);
    }
    this.child = child;

    child.on('error', (e) => this.fatal(this.friendlySpawnError(e)));
    child.on('exit', (code, sig) => {
      if (!this.closed) this.fatal(new Error(`MCP 服务器 ${this.name} 退出（code=${code}${sig ? ' sig=' + sig : ''}）`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdioData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    child.stdin.on('error', () => {});
  }

  friendlySpawnError(e) {
    const msg = String(e?.message || e);
    if (/EPERM|EACCES/.test(msg)) {
      return new Error(
        `启动 MCP 服务器 ${this.name} 被拒绝（${msg}）。若工作台跑在受限沙箱里，管道 stdio 被禁；改成普通终端启动即可。`
      );
    }
    return new Error(`启动 MCP 服务器 ${this.name} 失败：${msg}`);
  }

  onStdioData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 服务器往 stdout 打了非 JSON，忽略
      }
      this.dispatch(msg);
    }
  }

  /* ---------------- http / sse ---------------- */

  async openSseStream() {
    const ac = new AbortController();
    this.aborts.add(ac);
    this.endpointWait = new Promise((resolve, reject) => {
      this.endpointDone = resolve;
      this.endpointFail = reject;
    });
    let res;
    try {
      res = await fetch(this.baseUrl, {
        method: 'GET',
        headers: { accept: 'text/event-stream', ...this.headers },
        signal: ac.signal,
      });
    } catch (e) {
      throw this.friendlyHttpError(e);
    }
    this.captureSession(res);
    if (!res.ok) throw new Error(`MCP ${this.name}（sse）连 ${this.baseUrl} 返回 HTTP ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error(`MCP ${this.name}（sse）响应没有 body`);
    this.streamTask = this.consumeSseStream(res.body, true).catch((e) => {
      if (this.closed) return;
      this.fatal(e instanceof Error ? e : new Error(String(e)));
      try {
        this.endpointFail?.(e instanceof Error ? e : new Error(String(e)));
      } catch {
        /* ignore */
      }
    });
    await withTimeout(this.endpointWait, INIT_TIMEOUT_MS, `MCP ${this.name}（sse）连接超时：${INIT_TIMEOUT_MS}ms 内没收到 event:endpoint`);
  }

  /** legacy=true 时处理 endpoint 事件（旧版 SSE 的 POST 地址） */
  async consumeSseStream(body, legacy = false) {
    await readSse(body, (ev) => {
      if (legacy && ev.event === 'endpoint') {
        try {
          this.postUrl = new URL(ev.data, this.baseUrl).toString();
        } catch {
          this.postUrl = ev.data;
        }
        this.endpointDone?.(this.postUrl);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return; // 非 JSON 的 data 行忽略
      }
      this.dispatch(msg);
    });
    if (legacy) throw new Error(`MCP ${this.name}（sse）的消息流断开了`);
  }

  captureSession(res) {
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
  }

  httpHeaders() {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    // Streamable HTTP 从 2025-03-26 起要求带这个头；更早的版本没有它
    if (this.protocolVersion && this.protocolVersion >= '2025-03-26') h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }

  async postJson(obj, signal) {
    const target = this.kind === 'sse' ? this.postUrl : this.baseUrl;
    if (!target) throw new Error(`MCP ${this.name}（sse）还没拿到 POST 地址`);
    const ac = new AbortController();
    const link = () => {
      try {
        ac.abort(signal?.reason);
      } catch {
        /* ignore */
      }
    };
    if (signal) {
      if (signal.aborted) link();
      else signal.addEventListener('abort', link, { once: true });
    }
    this.aborts.add(ac);
    try {
      const res = await fetch(target, { method: 'POST', headers: this.httpHeaders(), body: JSON.stringify(obj), signal: ac.signal });
      this.captureSession(res);
      if (!res.ok) {
        let extra = '';
        if (res.status === 401 || res.status === 403) extra = '（需要鉴权，可在 headers 里配 Authorization）';
        else if (res.status === 404 && this.sessionId) extra = '（会话可能已失效，刷新 MCP 配置重连）';
        throw new Error(`MCP ${this.name} POST ${target} 返回 HTTP ${res.status} ${res.statusText}${extra}`);
      }
      // 通知的常规回应：202 Accepted / 204 No Content
      if (res.status === 202 || res.status === 204) return;
      const ct = String(res.headers.get('content-type') || '');
      if (ct.includes('text/event-stream')) {
        await this.consumeSseStream(res.body, false);
        return;
      }
      const text = await res.text();
      if (!text.trim()) return;
      if (ct.includes('application/json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
        this.dispatch(JSON.parse(text));
        return;
      }
      // 其它 content-type：当作无响应（有些实现会回纯文本 "Accepted"）
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error(`MCP ${this.name} 请求被取消`);
      if (/^MCP /.test(String(e?.message || ''))) throw e;
      throw this.friendlyHttpError(e);
    } finally {
      this.aborts.delete(ac);
      if (signal) {
        try {
          signal.removeEventListener('abort', link);
        } catch {
          /* ignore */
        }
      }
    }
  }

  friendlyHttpError(e) {
    const cause = e?.cause || {};
    const detail = [e?.message, cause.code, cause.message].filter(Boolean).join(' / ');
    const hint = /ENOTFOUND|EAI_AGAIN/.test(detail)
      ? '（域名解析失败）'
      : /ECONNREFUSED/.test(detail)
        ? '（连接被拒绝：服务没起或端口不对）'
        : /CERT|SSL|self[- ]signed|UNABLE_TO_VERIFY/i.test(detail)
          ? '（证书校验失败）'
          : /fetch failed/i.test(detail)
            ? '（网络不可达）'
            : '';
    return new Error(`连接 MCP 服务器 ${this.name}（${this.spec.url}）失败：${detail}${hint}`);
  }

  /* ---------------- JSON-RPC 收发 ---------------- */

  dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // 服务端发来的请求：我们没声明任何 capability，回 -32601 免得对方干等
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `客户端不支持 ${msg.method}` } }).catch(() => {});
    }
    // 通知（notifications/* 或没有 id 的消息）：不订阅，忽略
  }

  async send(obj, signal) {
    if (this.closed) throw new Error(`MCP 服务器 ${this.name} 已关闭`);
    if (this.kind === 'stdio') {
      if (!this.child) throw new Error(`MCP 服务器 ${this.name} 未连接`);
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return;
    }
    await this.postJson(obj, signal);
  }

  request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const ac = new AbortController();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          ac.abort();
        } catch {
          /* ignore */
        }
        reject(new Error(`MCP ${this.name}.${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      Promise.resolve()
        .then(() => this.send({ jsonrpc: '2.0', id, method, params }, ac.signal))
        .catch((e) => {
          if (!this.pending.has(id)) return; // 已经等到响应了
          this.pending.delete(id);
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params }, AbortSignal.timeout(NOTIFY_TIMEOUT_MS)).catch((e) => {
      this.stderr = (this.stderr + `\n${e?.message || e}`).slice(-4000);
    });
  }

  async initialize() {
    const res = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'bonsai-workbench', version: CLIENT_VERSION },
      },
      INIT_TIMEOUT_MS
    );
    this.protocolVersion = typeof res?.protocolVersion === 'string' ? res.protocolVersion : null;
    this.notify('notifications/initialized', {});
    return res;
  }

  async listTools() {
    const res = await this.request('tools/list', {}, INIT_TIMEOUT_MS);
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(toolName, args) {
    const res = await this.request('tools/call', { name: toolName, arguments: args && typeof args === 'object' ? args : {} });
    const parts = [];
    for (const c of res?.content || []) {
      if (c?.type === 'text') parts.push(String(c.text ?? ''));
      else if (c?.type === 'image') parts.push('[image]');
      else if (c?.type === 'resource') parts.push(`[resource ${c.resource?.uri || ''}]`);
    }
    const text = parts.join('\n').trim() || (res?.isError ? '(工具返回错误但无内容)' : '(无输出)');
    return { ok: !res?.isError, output: text };
  }

  failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** 连接级故障（子进程退出 / SSE 流断）：把在途请求全拒掉，并让上层改状态 */
  fatal(err) {
    this.failAll(err);
    try {
      this.onFatal?.(err);
    } catch {
      /* ignore */
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('MCP 已关闭'));
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
    for (const ac of this.aborts) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
    this.aborts.clear();
    // 主动结束 Streamable HTTP 会话（规范建议客户端这么做；服务端不支持就算了）
    if (this.kind === 'http' && this.sessionId) {
      try {
        fetch(this.baseUrl, { method: 'DELETE', headers: this.httpHeaders(), signal: AbortSignal.timeout(2000) }).catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }
}

/* ================= 注册表 ================= */

/** serverName -> { name, kind, spec, client, status, error, tools: [{name, description, inputSchema}] } */
const registry = new Map();

const sameSpec = (a, b) => mcpSpecKey(a) === mcpSpecKey(b);

/**
 * 按配置同步 MCP 服务器：新出现/配置变了的连上、关掉的断开。
 * 返回状态数组（不含大字段）。
 */
export async function syncMcp(cfg) {
  const wanted = cfg?.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};

  for (const [name, rec] of [...registry]) {
    const spec = wanted[name];
    if (!spec || spec.enabled === false) {
      rec.client?.close();
      registry.delete(name);
      continue;
    }
    if (rec.client && sameSpec(rec.spec, spec)) continue;
    rec.client?.close();
    registry.delete(name);
  }

  const results = [];
  for (const [name, spec] of Object.entries(wanted)) {
    if (!spec || spec.enabled === false) continue;
    if (registry.has(name)) {
      results.push(statusOf(registry.get(name)));
      continue;
    }
    const rec = { name, kind: '', spec, client: null, status: 'connecting', error: null, tools: [] };
    registry.set(name, rec);
    try {
      rec.kind = mcpTransportOf(spec);
      rec.client = new McpClient(name, spec);
      rec.client.onFatal = (e) => {
        rec.status = 'error';
        rec.error = String(e?.message || e);
      };
      await rec.client.start();
      await rec.client.initialize();
      const tools = await rec.client.listTools();
      rec.tools = tools.map((t) => ({
        name: String(t.name || ''),
        description: String(t.description || ''),
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      }));
      rec.status = 'ready';
    } catch (e) {
      rec.status = 'error';
      rec.error = String(e?.message || e);
      rec.client?.close();
    }
    results.push(statusOf(rec));
  }
  return results;
}

function statusOf(rec) {
  return {
    name: rec.name,
    transport: rec.kind || '',
    status: rec.status,
    error: rec.error,
    tools: rec.tools.map((t) => t.name),
    toolCount: rec.tools.length,
    stderr: rec.status === 'error' ? String(rec.client?.stderr || '').slice(-600) : '',
  };
}

export function mcpStatus() {
  return [...registry.values()].map(statusOf);
}

export function serverNames() {
  return [...registry.keys()];
}

/** 名字里带 __ 的原始 MCP 名要做映射：mcp__<server>__<tool> */
export function toolNameFor(server, tool) {
  return ['mcp', server, tool].join(NAME_SEP);
}

export function parseToolName(full) {
  const parts = String(full || '').split(NAME_SEP);
  if (parts.length < 3 || parts[0] !== 'mcp') return null;
  return { server: parts[1], tool: parts.slice(2).join(NAME_SEP) };
}

/** 把已连上的 MCP 工具转成工作台的工具定义 */
export function mcpToolDefs() {
  const defs = [];
  for (const rec of registry.values()) {
    if (rec.status !== 'ready') continue;
    for (const t of rec.tools) {
      const params =
        t.inputSchema && t.inputSchema.type === 'object'
          ? t.inputSchema
          : { type: 'object', properties: {}, ...(t.inputSchema || {}) };
      defs.push({
        name: toolNameFor(rec.name, t.name),
        risk: 'exec',
        source: 'mcp',
        hint: `${toolNameFor(rec.name, t.name)}(...) MCP 工具（${rec.kind}）：${(t.description || t.name).slice(0, 60)}`,
        description: `[MCP:${rec.name}] ${t.description || t.name}`,
        parameters: params,
      });
    }
  }
  return defs;
}

export async function callMcpTool(fullName, args) {
  const parsed = parseToolName(fullName);
  if (!parsed) return { ok: false, output: `err: 不是 MCP 工具名：${fullName}` };
  const rec = registry.get(parsed.server);
  if (!rec) return { ok: false, output: `err: MCP 服务器 ${parsed.server} 未连接` };
  if (rec.status !== 'ready') return { ok: false, output: `err: MCP 服务器 ${parsed.server} 状态 ${rec.status}：${rec.error || ''}` };
  try {
    return await rec.client.callTool(parsed.tool, args);
  } catch (e) {
    return { ok: false, output: `err: MCP 调用失败 ${e?.message || e}` };
  }
}

export function closeMcp() {
  for (const rec of registry.values()) rec.client?.close();
  registry.clear();
}
