import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.mjs';

/**
 * 记忆分层（v0.6.0）
 *
 * 五层，全部落在 <BW_DATA>/memory/ 下（BW_MEMORY_DIR 可覆盖）：
 *   user    用户档案          user.md               —— 自动注入
 *   memory  全局记忆          memory.md             —— 自动注入
 *   key     本项目关键记忆    key/<slug>.md         —— 自动注入
 *   project 项目日志          project/<slug>.md     —— 不注入，按需检索
 *   daily   每日日志          daily/YYYY-MM-DD.md   —— 不注入；每次 run 结束自动追加一条
 *
 * 条目格式统一：`- [YYYY-MM-DD HH:MM] 文本`（一行一条，文本内的换行压成 " / "）。
 * slug 由 workspace 绝对路径算出：basename 净化 + sha1 前 8 hex（同一目录永远同一 slug）。
 *
 * 上下文成本：只注 user/memory/key，逐层按 cfg.memory.*MaxChars 截断，总长再按
 * cfg.memory.injectMaxChars 封顶；无记忆内容时不产生任何注入。
 */

export const MEMORY_DIR = process.env.BW_MEMORY_DIR || path.join(DATA_DIR, 'memory');

export const TARGETS = ['user', 'memory', 'key', 'project', 'daily'];

export const LABELS = {
  user: '用户档案',
  memory: '全局记忆',
  key: '本项目关键记忆',
  project: '项目日志',
  daily: '每日日志',
};

/** 自动注入的层（顺序即注入顺序） */
export const INJECT_LAYERS = ['user', 'memory', 'key'];

export const MAX_ENTRIES = 400; // 每层最多保留条数，超出丢最旧
const MAX_CONTENT = 2000; // 单条正文上限

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 条目时间戳 "YYYY-MM-DD HH:MM" */
export function stampOf(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 当天日志文件名 */
export function dayName(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.md`;
}

/** workspace 绝对路径 → 稳定 slug（小写定标，Windows 路径大小写不敏感） */
export function workspaceSlug(workspace) {
  const abs = path.resolve(String(workspace || process.cwd()));
  const base =
    path
      .basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 40) || 'project';
  const hash = createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** 某一层的落盘文件（daily 即今天） */
export function fileOf(target, cfg) {
  const t = String(target || '').trim();
  const slug = workspaceSlug(cfg?.workspace);
  if (t === 'user') return path.join(MEMORY_DIR, 'user.md');
  if (t === 'memory') return path.join(MEMORY_DIR, 'memory.md');
  if (t === 'key') return path.join(MEMORY_DIR, 'key', `${slug}.md`);
  if (t === 'project') return path.join(MEMORY_DIR, 'project', `${slug}.md`);
  if (t === 'daily') return path.join(MEMORY_DIR, 'daily', dayName());
  throw new Error(`不认识的记忆层：${t || '(空)'}（可用：${TARGETS.join(' / ')}）`);
}

const ENTRY_RE = /^-\s*\[([0-9]{4}-[0-9]{2}-[0-9]{2}(?: [0-9]{2}:[0-9]{2})?)\]\s*(.*)$/;

function normalizeContent(content) {
  return String(content ?? '')
    .replace(/\r?\n+/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CONTENT);
}

/** 读某层全部条目（按时间正序） */
export function readEntries(target, cfg) {
  let text = '';
  try {
    text = fs.readFileSync(fileOf(target, cfg), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(ENTRY_RE);
    if (m) out.push({ date: m[1], text: m[2] });
  }
  return out;
}

function layerOfFile(absFile) {
  const rel = path.relative(MEMORY_DIR, absFile).replace(/\\/g, '/');
  if (rel === 'user.md') return 'user';
  if (rel === 'memory.md') return 'memory';
  if (rel.startsWith('key/')) return 'key';
  if (rel.startsWith('project/')) return 'project';
  if (rel.startsWith('daily/')) return 'daily';
  return 'unknown';
}

function trimFile(file, target) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n');
  const kept = lines.filter((l) => ENTRY_RE.test(l));
  if (kept.length <= MAX_ENTRIES) return;
  const header = `# ${LABELS[target] || target}\n\n`;
  const body = kept.slice(-MAX_ENTRIES).join('\n') + '\n';
  fs.writeFileSync(file, header + body, 'utf8');
}

/**
 * 追加一条记忆。
 * @returns {{ok:true,target:string,file:string,count:number,line:string}}
 */
export function addMemory({ cfg, target = 'key', content, date = new Date() } = {}) {
  if (cfg?.memory?.enabled === false) throw new Error('记忆已关闭（cfg.memory.enabled = false）');
  const t = String(target || 'key').trim();
  const c = normalizeContent(content);
  if (!c) throw new Error('content 不能为空');
  const file = fileOf(t, cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prev = '';
  try {
    prev = fs.readFileSync(file, 'utf8');
  } catch {
    /* 首次创建 */
  }
  const line = `- [${stampOf(date)}] ${c}`;
  let text = prev.trim() ? prev.replace(/\s*$/, '') + '\n' : `# ${LABELS[t] || t}\n\n`;
  text += line + '\n';
  fs.writeFileSync(file, text, 'utf8');
  trimFile(file, t);
  return { ok: true, target: t, file, count: readEntries(t, cfg).length, line };
}

/** 列某层条目（默认最近 30 条，新的在后） */
export function listMemory({ cfg, target = 'key', limit = 30 } = {}) {
  const t = String(target || 'key').trim();
  const all = readEntries(t, cfg);
  const n = Math.max(1, Math.min(Number(limit) || 30, MAX_ENTRIES));
  return {
    ok: true,
    target: t,
    label: LABELS[t] || t,
    file: fileOf(t, cfg),
    total: all.length,
    entries: all.slice(-n),
  };
}

/** 跨层检索（字面、大小写不敏感） */
export function searchMemory({ cfg, query, limit = 20 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) throw new Error('query 不能为空');
  const files = [];
  const push = (p) => {
    if (fs.existsSync(p)) files.push(p);
  };
  push(path.join(MEMORY_DIR, 'user.md'));
  push(path.join(MEMORY_DIR, 'memory.md'));
  for (const sub of ['key', 'project', 'daily']) {
    const dir = path.join(MEMORY_DIR, sub);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names.filter((x) => x.endsWith('.md')).sort()) push(path.join(dir, n));
  }
  const hits = [];
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = line.match(ENTRY_RE);
      if (!m || !m[2].toLowerCase().includes(q)) continue;
      hits.push({ layer: layerOfFile(f), file: f, date: m[1], text: m[2] });
      if (hits.length >= Math.max(1, Number(limit) || 20)) {
        return { ok: true, query: String(query).trim(), count: hits.length, hits };
      }
    }
  }
  return { ok: true, query: String(query).trim(), count: hits.length, hits };
}

/** 删除某层中唯一命中 match 的条目 */
export function removeMemory({ cfg, target = 'key', match } = {}) {
  const t = String(target || 'key').trim();
  const needle = String(match || '').trim();
  if (!needle) throw new Error('match 不能为空（要给能唯一命中的片段）');
  const file = fileOf(t, cfg);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`记忆层 ${t} 还没有内容`);
  }
  const lines = text.split('\n');
  const idx = [];
  lines.forEach((l, i) => {
    const m = l.match(ENTRY_RE);
    if (m && m[2].includes(needle)) idx.push(i);
  });
  if (!idx.length) throw new Error(`未命中：${needle}`);
  if (idx.length > 1) throw new Error(`命中 ${idx.length} 条，请给更精确的片段`);
  lines.splice(idx[0], 1);
  fs.writeFileSync(file, lines.join('\n').replace(/\s*$/, '\n'), 'utf8');
  return { ok: true, target: t, file, removed: needle, count: readEntries(t, cfg).length };
}

function toInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : dflt;
}

/**
 * 自动注入块（只含 user / memory / key）。
 * 无内容或 cfg.memory.enabled === false 时返回空串 —— 空记忆不花任何 token。
 */
export function injectionBlock(cfg) {
  if (cfg?.memory?.enabled === false) return '';
  const caps = {
    user: toInt(cfg?.memory?.userMaxChars, 500),
    memory: toInt(cfg?.memory?.memoryMaxChars, 700),
    key: toInt(cfg?.memory?.keyMaxChars, 900),
  };
  const total = toInt(cfg?.memory?.injectMaxChars, 2200);
  if (total <= 0) return '';
  const parts = [];
  for (const t of INJECT_LAYERS) {
    const entries = readEntries(t, cfg);
    const cap = caps[t] || 0;
    if (!entries.length || cap <= 0) continue;
    const lines = [];
    let used = 0;
    for (let i = entries.length - 1; i >= 0 && lines.length < 40; i -= 1) {
      const line = `- [${entries[i].date}] ${entries[i].text}`;
      if (lines.length && used + line.length + 1 > cap) break;
      lines.unshift(line);
      used += line.length + 1;
    }
    if (lines.length) parts.push(`【${LABELS[t]}】\n${lines.join('\n')}`);
  }
  if (!parts.length) return '';
  let body = `【长期记忆（自动注入，来自本工作台的分层记忆）】\n${parts.join('\n')}\n（更早的细节、项目日志与每日日志不在注入内；需要时用 memory 工具检索，新结论用 memory 工具写入。）`;
  if (body.length > total) body = `${body.slice(0, Math.max(0, total - 10))}\n……（已截断）`;
  return body;
}

/**
 * 记忆库为空时的提示（v0.7.1）。机制在、没人喂：模型不会主动想到去调 memory，
 * injectChars 就永远 0（三层全空 = 形同未启用）。空库时补一句「本轮顺手记」，
 * 一旦有任何一层有内容就自动消失（只花一条短句）。
 */
export function memoryEmptyHint(cfg) {
  if (cfg?.memory?.enabled === false) return '';
  if (injectionBlock(cfg)) return '';
  return '（记忆库还空着：本轮若出现长期有用的事实——用户偏好、环境真值、本项目关键结论——用 memory 工具写入 user/memory/key 层，下一轮会自动注入；一次性细节不写。）';
}

/** run 结束自动写每日日志（cfg.memory.daily === false 时跳过） */
export function appendDaily({ cfg, text, date = new Date() } = {}) {
  if (cfg?.memory?.enabled === false || cfg?.memory?.daily === false) return false;
  const c = normalizeContent(text);
  if (!c) return false;
  try {
    addMemory({ cfg, target: 'daily', content: c, date });
    return true;
  } catch {
    return false; // 记忆写失败不影响 run 本身
  }
}

/** 清理超过 days 天的每日日志（启动时调一次） */
export function pruneDaily(days = 30) {
  const dir = path.join(MEMORY_DIR, 'daily');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - Math.max(1, Number(days) || 30) * 86400000;
  let removed = 0;
  for (const n of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(n)) continue;
    const t = Date.parse(`${n.slice(0, 10)}T00:00:00`);
    if (Number.isFinite(t) && t < cutoff) {
      try {
        fs.unlinkSync(path.join(dir, n));
        removed += 1;
      } catch {
        /* 删不掉不影响 */
      }
    }
  }
  return removed;
}

/** /api/memory 用的完整快照（含注入块） */
export function memoryStats(cfg) {
  const layers = TARGETS.map((t) => {
    const entries = readEntries(t, cfg);
    return {
      target: t,
      label: LABELS[t],
      file: fileOf(t, cfg),
      injected: INJECT_LAYERS.includes(t),
      count: entries.length,
      chars: entries.reduce((n, e) => n + e.text.length, 0),
      preview: entries.slice(-8),
    };
  });
  const block = injectionBlock(cfg);
  return {
    ok: true,
    dir: MEMORY_DIR,
    slug: workspaceSlug(cfg?.workspace),
    enabled: cfg?.memory?.enabled !== false,
    injectChars: block.length,
    block,
    layers,
  };
}

/** /api/state 用的轻量摘要（不带注入块与条目预览） */
export function memoryStatus(cfg) {
  const s = memoryStats(cfg);
  return {
    ok: true,
    dir: s.dir,
    slug: s.slug,
    enabled: s.enabled,
    injectChars: s.injectChars,
    layers: s.layers.map((l) => ({ target: l.target, label: l.label, count: l.count, chars: l.chars, injected: l.injected })),
  };
}
