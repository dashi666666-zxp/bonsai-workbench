import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { resolvePath } from './permission.mjs';
import { mcpToolDefs, callMcpTool } from './mcp.mjs';
import { pluginToolDefs, callPluginTool } from './plugins.mjs';
import { searchWeb, formatResults } from './search.mjs';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'target',
]);

export const TOOLS = [
  {
    name: 'list_dir',
    risk: 'read',
    hint: 'list_dir(path) 列出目录内容',
    description: 'List files and folders in a directory. Shows type and size.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path, relative to workspace. Default "."' } },
    },
  },
  {
    name: 'read_file',
    risk: 'read',
    hint: 'read_file(path, start?, end?) 读文本文件（带行号）',
    description: 'Read a UTF-8 text file with line numbers. Use start/end for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        start: { type: 'integer', description: 'First line, 1-based' },
        end: { type: 'integer', description: 'Last line, inclusive' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    risk: 'write',
    hint: 'write_file(path, content) 新建或覆盖文件',
    description: 'Create a file or overwrite it completely. Parent folders are created.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    risk: 'write',
    hint: 'edit_file(path, old, new, replaceAll?) 精确替换片段',
    description: 'Replace an exact text fragment. "old" must appear exactly once unless replaceAll is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old: { type: 'string', description: 'Exact text to find' },
        new: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'old', 'new'],
    },
  },
  {
    name: 'search_files',
    risk: 'read',
    hint: 'search_files(pattern, path?, include?) 全文/正则搜索',
    description: 'Search text or a regular expression across files. Returns path:line: text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Literal text or regex' },
        path: { type: 'string', description: 'Directory to search, default "."' },
        include: { type: 'string', description: 'Filename suffix filter, e.g. ".js" or ".md"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    risk: 'exec',
    hint: 'run_command(command, cwd?, timeoutMs?) 执行 shell 命令',
    description: 'Run a shell command inside the workspace and return stdout+stderr and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command' },
        cwd: { type: 'string', description: 'Working directory, default workspace root' },
        timeoutMs: { type: 'integer', description: 'Timeout in ms, default 60000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'web_fetch',
    risk: 'net',
    hint: 'web_fetch(url) 抓取网页并转成纯文本',
    description: 'Fetch a URL and return readable text. HTML is converted to plain text.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http:// or https:// URL' } },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    risk: 'net',
    hint: 'web_search(query, count?) 联网搜索（要最新信息时用）',
    description:
      'Search the web (Bing/DuckDuckGo HTML, no API key). Returns numbered results with title, URL and snippet. Use web_fetch on a URL for details.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'integer', description: 'How many results, 1-15, default 8' },
      },
      required: ['query'],
    },
  },
];

/* ---------------- 本地知识库（RAG） ---------------- */

export const RAG_TOOLS = [
  {
    name: 'rag_search',
    risk: 'read',
    source: 'rag',
    hint: 'rag_search(query, k?) 检索本地知识库（返回文件:行号与 [S#] 编号）',
    description:
      'Search the local RAG knowledge base (BM25 over chunked local files). Returns chunks with file:line and [S#] ids. Use it when you need exact wording, paths or numbers that are not already in the prompt.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        k: { type: 'integer', description: 'How many chunks, 1-12, default from settings' },
      },
      required: ['query'],
    },
  },
  {
    name: 'rag_index',
    risk: 'exec',
    source: 'rag',
    hint: 'rag_index(root?, rebuild?) 重建本地知识库索引',
    description:
      'Rebuild the local RAG index by scanning the knowledge base directory (default = configured root or workspace). Use after documents change.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Directory to index, default = configured root/workspace' },
        rebuild: { type: 'boolean', description: 'Ignore incremental cache and rebuild all chunks' },
      },
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/* ---------------- 多智能体：模型可调用的三件套 ---------------- */

export const AGENT_TOOLS = [
  {
    name: 'spawn_agent',
    risk: 'agent',
    source: 'agent',
    hint: 'spawn_agent(task, name?, model?) 派一个子智能体在后台干活，立刻返回 agentId',
    description:
      'Spawn a background sub-agent with its own context to work on an independent subtask. Returns immediately. Use agent_status to poll and message_agent to steer.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Self-contained task description for the sub-agent' },
        name: { type: 'string', description: 'Short label shown in the UI' },
        model: { type: 'string', description: 'Optional model override, default same as parent' },
      },
      required: ['task'],
    },
  },
  {
    name: 'message_agent',
    risk: 'agent',
    source: 'agent',
    hint: 'message_agent(agentId, text) 给还在跑的子体追加要求（它下一步会看到）',
    description: 'Send an additional instruction to a running sub-agent. It is delivered at its next step boundary.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id returned by spawn_agent' },
        text: { type: 'string', description: 'Additional instruction' },
      },
      required: ['agentId', 'text'],
    },
  },
  {
    name: 'agent_status',
    risk: 'read',
    source: 'agent',
    hint: 'agent_status(agentId?) 查看子体进度与最近输出（不传看全部）',
    description: 'Check sub-agent progress: status, steps, last output text, and final answer when finished.',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'Agent id, omit to list all' } },
    },
  },
];

const AGENT_IMPL = {
  async spawn_agent(args, ctx) {
    if (!ctx.agents) throw new Error('当前运行没有启用子智能体');
    const task = String(args.task ?? '').trim();
    if (!task) throw new Error('task 不能为空');
    const r = ctx.agents.spawn({ task, name: args.name, model: args.model });
    return [
      `已派出 ${r.name}（agentId=${r.agentId}，模型 ${r.model}），它在后台跑。`,
      '用 agent_status 看进度（含 final），用 message_agent 追加要求。',
      '不要自己重复子体的工作。',
    ].join('\n');
  },
  async message_agent(args, ctx) {
    if (!ctx.agents) throw new Error('当前运行没有启用子智能体');
    return ctx.agents.message(String(args.agentId || ''), String(args.text ?? ''));
  },
  async agent_status(args, ctx) {
    if (!ctx.agents) throw new Error('当前运行没有启用子智能体');
    const list = ctx.agents.status(args.agentId ? String(args.agentId) : null);
    if (!list.length) return '(还没有派出子智能体)';
    return list
      .map((a) =>
        [
          `${a.agentId}  ${a.name}  [${a.status}]  步数 ${a.steps}${a.model ? `  模型 ${a.model}` : ''}`,
          `  任务：${a.task.slice(0, 160)}`,
          a.lastText ? `  最近输出：${a.lastText.slice(0, 300)}` : '',
          a.final ? `  最终答复：${a.final.slice(0, 800)}` : '',
          a.error ? `  错误：${a.error}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      )
      .join('\n\n');
  },
};

/** 当前配置下可用的全部工具（内置 + MCP + 插件 + 多智能体 + 技能） */
export function allTools(cfg) {
  const list = TOOLS.filter((t) => (t.name === 'web_search' ? !cfg || cfg.webSearch !== false : true));
  list.push(...mcpToolDefs());
  if (!cfg || cfg.pluginsEnabled !== false) list.push(...pluginToolDefs());
  if (!cfg || cfg.agentsEnabled !== false) list.push(...AGENT_TOOLS);
  if (!cfg || cfg.skillsEnabled !== false) list.push(...SKILL_TOOLS);
  if (!cfg || cfg.rag?.enabled !== false) list.push(...RAG_TOOLS);
  if (!cfg || cfg.memory?.enabled !== false) list.push(...MEMORY_TOOLS);
  return list;
}

/* ---------------- 技能 ---------------- */

export const SKILL_TOOLS = [
  {
    name: 'skill',
    risk: 'read',
    source: 'skill',
    hint: 'skill(name?) 不传名字列出本地技能；传名字加载该技能的操作手册',
    description:
      'List local skills (SKILL.md packages) or load one skill\'s full instructions. Skills live in ~/.agents/skills and ~/.dsh/skills.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name; omit to list all enabled skills' } },
    },
  },
];



/* ---------------- 记忆分层（跨会话长期记忆） ---------------- */

export const MEMORY_TOOLS = [
  {
    name: 'memory',
    risk: 'write',
    source: 'memory',
    hint: 'memory(action, target?, content?, query?, match?) 分层记忆 add/list/search/remove',
    description:
      'Layered long-term memory shared across sessions. action=add|list|search|remove. target=user (user profile, auto-injected) | memory (global facts, auto-injected) | key (project key facts, auto-injected) | project (project log, not injected) | daily (today log). Persist stable preferences and conclusions only; never one-off details.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'search', 'remove'], description: 'Operation' },
        target: {
          type: 'string',
          enum: ['user', 'memory', 'key', 'project', 'daily'],
          description: 'Memory layer, default key',
        },
        content: { type: 'string', description: 'One-line text to add' },
        query: { type: 'string', description: 'Keyword for search' },
        match: { type: 'string', description: 'Unique substring of the entry to remove' },
        limit: { type: 'integer', description: 'Max entries/hits, 1-50' },
      },
      required: ['action'],
    },
  },
];

const MEMORY_IMPL = {
  async memory(args, ctx) {
    const mem = await import('./memory.mjs');
    const cfg = ctx?.cfg || {};
    if (cfg.memory?.enabled === false) throw new Error('记忆已关闭（设置 → 记忆分层 里可开启）');
    const action = String(args.action || '').trim().toLowerCase();
    const target = String(args.target || 'key').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(args.limit) || 0, 0), 50) || undefined;
    const label = (t) => mem.LABELS[t] || t;
    if (action === 'add') {
      const r = mem.addMemory({ cfg, target, content: args.content });
      return `已写入【${label(r.target)}】第 ${r.count} 条：\n${r.line}\n（文件 ${r.file}）`;
    }
    if (action === 'list') {
      const r = mem.listMemory({ cfg, target, limit: limit || 20 });
      if (!r.entries.length) return `【${r.label}】还没有条目（${r.file}）`;
      return [
        `【${r.label}】共 ${r.total} 条，最近 ${r.entries.length} 条：`,
        ...r.entries.map((e) => `- [${e.date}] ${e.text}`),
        `（文件 ${r.file}）`,
      ].join('\n');
    }
    if (action === 'search') {
      const r = mem.searchMemory({ cfg, query: args.query || args.content, limit: limit || 20 });
      if (!r.count) return `没有命中「${r.query}」的记忆。`;
      return [`命中 ${r.count} 条：`, ...r.hits.map((h) => `- [${label(h.layer)}] [${h.date}] ${h.text}`)].join('\n');
    }
    if (action === 'remove') {
      const r = mem.removeMemory({ cfg, target, match: args.match || args.content });
      return `已从【${label(r.target)}】删除「${r.removed}」，剩 ${r.count} 条。`;
    }
    throw new Error(`action 必须是 add / list / search / remove，收到：${action || '(空)'}`);
  },
};

const SKILL_IMPL = {
  async skill(args, ctx) {
    const name = String(args.name ?? '').trim();
    const { skillList, loadSkillBody } = await import('./skills.mjs');
    if (!name) {
      const list = skillList();
      const on = list.filter((s) => s.enabled && !s.error);
      if (!on.length) return '(没有已启用的技能。把技能包放到 ~/.agents/skills/<名字>/SKILL.md)';
      return [
        `本地技能 ${on.length} 个（用 skill(name) 加载某一个）：`,
        ...on.map((s) => `- ${s.name}：${(s.description || '(无描述)').slice(0, 200)}`),
      ].join('\n');
    }
    const body = loadSkillBody(name);
    if (!body.ok) throw new Error(String(body.output).replace(/^err:\s*/, ''));
    return body.output;
  },
};



export function toolNames(list) {
  return (list || allTools()).map((t) => t.name);
}

export function findTool(name, list) {
  return (list || allTools()).find((t) => t.name === name) || byName.get(name) || null;
}

export function toolSchema(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function list_dir(args, ctx) {
  const { abs } = resolvePath(args.path || '.', ctx.cfg.workspace);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  const shown = entries.slice(0, 300);
  const rows = [];
  for (const e of shown) {
    if (e.isDirectory()) rows.push(`d  ${e.name}/`);
    else {
      const st = await fsp.stat(path.join(abs, e.name)).catch(() => null);
      rows.push(`-  ${e.name}${st ? `  ${st.size}B` : ''}`);
    }
  }
  if (entries.length > shown.length) rows.push(`... 共 ${entries.length} 项，仅显示前 ${shown.length}`);
  return rows.length ? rows.join('\n') : '(空目录)';
}

async function read_file(args, ctx) {
  const { abs } = resolvePath(args.path, ctx.cfg.workspace);
  const text = await fsp.readFile(abs, 'utf8');
  if (text.includes('\u0000')) throw new Error('看起来是二进制文件，不读');
  const lines = text.split('\n');
  let start = Math.max(1, Number(args.start) || 1);
  let end = Number(args.end) || lines.length;
  end = Math.min(end, lines.length);
  if (start > end) throw new Error(`start(${start}) 大于 end(${end})，文件共 ${lines.length} 行`);
  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(5)}\t${l}`)
    .join('\n');
  const more = end < lines.length ? `\n... 还有 ${lines.length - end} 行，用 start=${end + 1} 继续读` : '';
  return body + more;
}

async function write_file(args, ctx) {
  const { abs } = resolvePath(args.path, ctx.cfg.workspace);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
  await fsp.writeFile(abs, content, 'utf8');
  return `已写入 ${abs}（${Buffer.byteLength(content, 'utf8')} 字节）`;
}

async function edit_file(args, ctx) {
  const { abs } = resolvePath(args.path, ctx.cfg.workspace);
  const oldText = String(args.old ?? '');
  if (!oldText) throw new Error('old 不能为空');
  const text = await fsp.readFile(abs, 'utf8');
  const count = text.split(oldText).length - 1;
  if (count === 0) throw new Error(`文件里找不到这段原文（${oldText.slice(0, 60)}...）`);
  if (count > 1 && !args.replaceAll) {
    throw new Error(`这段原文出现 ${count} 次，请提供更多上下文让它唯一，或传 replaceAll=true`);
  }
  const next = args.replaceAll ? text.split(oldText).join(String(args.new ?? '')) : text.replace(oldText, String(args.new ?? ''));
  await fsp.writeFile(abs, next, 'utf8');
  return `已修改 ${abs}（替换 ${args.replaceAll ? count : 1} 处）`;
}

async function search_files(args, ctx) {
  const { abs: root } = resolvePath(args.path || '.', ctx.cfg.workspace);
  const include = String(args.include || '').trim().toLowerCase();
  const pattern = String(args.pattern ?? '');
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const results = [];
  const MAX_RESULTS = 200;
  const MAX_FILES = 3000;
  let files = 0;

  async function walk(dir, depth) {
    if (results.length >= MAX_RESULTS || files >= MAX_FILES || depth > 8) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= MAX_RESULTS || files >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (include && !e.name.toLowerCase().endsWith(include)) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st || st.size > 2 * 1024 * 1024) continue;
      files++;
      let text;
      try {
        text = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
        if (re.test(lines[i])) {
          results.push(`${path.relative(ctx.cfg.workspace, full)}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
      }
    }
  }

  await walk(root, 0);
  if (!results.length) return `(无匹配，扫描了 ${files} 个文件)`;
  const tail = results.length >= MAX_RESULTS ? `\n... 结果超过 ${MAX_RESULTS} 条已截断` : '';
  return results.join('\n') + tail;
}

async function run_command(args, ctx) {
  const command = String(args.command ?? '').trim();
  if (!command) throw new Error('command 为空');
  const cwd = args.cwd ? resolvePath(args.cwd, ctx.cfg.workspace).abs : ctx.cfg.workspace;
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 60000, 1000), 300000);
  const tmp = path.join(os.tmpdir(), `ow-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
  const fd = fs.openSync(tmp, 'a');
  let child;
  try {
    child = spawn(command, {
      shell: true,
      cwd,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, BW_AGENT: '1' },
    });
  } finally {
    fs.closeSync(fd);
  }

  let hit = false;
  const onAbort = () => {
    hit = true;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  };
  const timer = setTimeout(onAbort, timeoutMs);
  if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

  const code = await new Promise((resolve) => {
    child.on('close', (c, sig) => resolve(sig ? -1 : c));
    child.on('error', () => resolve(-1));
  });
  clearTimeout(timer);
  if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);

  let out = '';
  try {
    out = await fsp.readFile(tmp, 'utf8');
  } catch {
    /* ignore */
  }
  fsp.unlink(tmp).catch(() => {});
  out = stripAnsi(out).trimEnd();
  const head = `exit=${code}${hit ? ' (timeout/killed)' : ''} cwd=${cwd}`;
  return `${head}\n${out || '(无输出)'}`;
}

async function web_fetch(args, ctx) {
  const url = String(args.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https URL');
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
  });
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();
  const body = ct.includes('html') ? htmlToText(raw) : raw;
  const head = `HTTP ${res.status} ${url}\n`;
  return head + (body.trim() || '(空内容)');
}

async function web_search(args, ctx) {
  const q = String(args.query ?? args.q ?? '').trim();
  if (!q) throw new Error('query 不能为空');
  const cfg = ctx?.cfg || {};
  const count = Number(args.count) || Number(cfg.webSearchCount) || 8;
  const r = await searchWeb(q, { count, engine: cfg.webSearchEngine || 'auto' });
  if (!r.ok) throw new Error(`搜索失败：${r.error}${r.tried ? `（已试 ${r.tried.join(' → ')}）` : ''}`);
  return formatResults(q, r.results, r.engine, r.cached);
}

const RAG_IMPL = {
  async rag_search(args, ctx) {
    const { retrieve } = await import('./rag.mjs');
    const q = String(args.query ?? args.q ?? '').trim();
    if (!q) throw new Error('query 不能为空');
    const r = retrieve({ cfg: ctx?.cfg || {}, query: q, k: Number(args.k) || undefined });
    if (!r.ok) return `检索失败：${r.reason || '未知原因'}`;
    const lines = [`检索「${q}」· 词 ${r.tokens} 个 · 命中 ${r.matched} 块 · 取 ${r.chunks.length} 块 · ${r.tookMs} ms`, ''];
    r.chunks.forEach((c, i) => {
      lines.push(`[S${i + 1}] ${c.file} · ${c.heading || '(无标题)'} · 行 ${c.startLine}-${c.endLine} · 分 ${c.score}`);
      lines.push(String(c.text || '').trim());
      lines.push('');
    });
    lines.push('引用这些资料时用上面的 [S#] 编号。');
    return lines.join('\n');
  },
  async rag_index(args, ctx) {
    const { buildIndex } = await import('./rag.mjs');
    const meta = buildIndex({
      cfg: ctx?.cfg || {},
      root: args.root ? String(args.root) : undefined,
      rebuild: Boolean(args.rebuild),
    });
    return [
      `索引已重建：${meta.files} 个文件 / ${meta.chunks} 块 / ${meta.tokens} 词 / ${(meta.indexBytes / 1024).toFixed(1)} KB / ${meta.ms} ms`,
      meta.truncated ? '注意：达到文件数或块数上限，有内容未索引。' : '',
      `目录：${meta.root}`,
    ].filter(Boolean).join('\n');
  },
};

const IMPL = { list_dir, read_file, write_file, edit_file, search_files, run_command, web_fetch, web_search };

/**
 * 执行一个工具。
 * @returns {Promise<{ok:boolean, output:string}>}
 */
export async function execTool(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  const impl = IMPL[name];
  if (impl && byName.has(name)) {
    try {
      const out = await impl(a, ctx);
      return { ok: true, output: String(out ?? '') };
    } catch (e) {
      return { ok: false, output: `err: ${e?.message || e}` };
    }
  }
  const agentImpl = AGENT_IMPL[name];
  if (agentImpl) {
    try {
      const out = await agentImpl(a, ctx);
      return { ok: true, output: String(out ?? '') };
    } catch (e) {
      return { ok: false, output: `err: ${e?.message || e}` };
    }
  }
  for (const group of [SKILL_IMPL, RAG_IMPL, MEMORY_IMPL]) {
    const fn = group[name];
    if (!fn) continue;
    try {
      const out = await fn(a, ctx);
      return { ok: true, output: String(out ?? '') };
    } catch (e) {
      return { ok: false, output: `err: ${e?.message || e}` };
    }
  }
  if (String(name).startsWith('plugin__')) return callPluginTool(name, a, ctx);
  if (String(name).startsWith('mcp__')) return callMcpTool(name, a);
  return { ok: false, output: `err: 没有叫 ${name} 的工具` };
}
