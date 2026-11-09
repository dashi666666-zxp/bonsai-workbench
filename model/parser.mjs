/**
 * 三层工具调用适配的解析层：
 *  1. 原生 tool_calls（normalizeNativeCalls）
 *  2. content 里的 JSON 文本（extractToolCalls）
 *  3. 工具名纠错（fuzzyToolName）——弱模型会编造/拼错工具名
 */

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[n];
}

/**
 * 把模型给的乱名字映射到真实工具名。
 * 只在“足够像”时才映射，避免静默调用错工具。
 */
export function fuzzyToolName(name, toolNames) {
  const want = String(name || '').trim();
  if (!want) return null;
  if (toolNames.includes(want)) return want;
  const nw = norm(want);
  if (!nw) return null;
  for (const t of toolNames) if (norm(t) === nw) return t;
  // 子串包含（file_reader -> read_file 不命中，但 read_file_content -> read_file 命中）
  const subs = toolNames.filter((t) => nw.includes(norm(t)) || norm(t).includes(nw));
  if (subs.length === 1) return subs[0];
  // 词干全覆盖：弱模型常把 read_file 写成 file_reader / read-content 这类换序名字
  const stemmed = toolNames.filter((t) => {
    const words = t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w, i, arr) => w.length >= 3 && arr.indexOf(w) === i);
    return words.length > 0 && words.every((w) => nw.includes(w));
  });
  if (stemmed.length === 1) return stemmed[0];
  // 编辑距离
  let best = null;
  let bestScore = 0;
  for (const t of toolNames) {
    const nt = norm(t);
    const d = levenshtein(nw, nt);
    const score = 1 - d / Math.max(nw.length, nt.length);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return bestScore >= 0.86 ? best : null;
}

function parseArgs(a) {
  if (a == null) return {};
  if (typeof a === 'string') {
    const s = a.trim();
    if (!s) return {};
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  if (typeof a === 'object') return a;
  return {};
}

/**
 * 把 Ollama 原生 tool_calls 规范化成 [{id,name,args}]。
 */
export function normalizeNativeCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const out = [];
  toolCalls.forEach((c, i) => {
    const fn = c?.function || c || {};
    const name = fn.name || fn.tool || '';
    if (!name) return;
    out.push({
      id: c?.id || `call_${i}`,
      name: String(name),
      args: parseArgs(fn.arguments ?? fn.args ?? fn.parameters),
    });
  });
  return out;
}

/** 在文本里扫描所有“括号配平”的 JSON 对象 */
function scanJsonObjects(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          found.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

function pickCallObject(obj, toolNames) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : null;
  const rawName = fn?.name || obj.tool || obj.tool_name || obj.toolName || obj.name || obj.action || '';
  const name = String(rawName || '').trim();
  if (!name) return null;
  const looksLikeTool =
    Boolean(fn) ||
    'tool' in obj ||
    'tool_name' in obj ||
    'toolName' in obj ||
    'name' in obj && !('content' in obj) && !('text' in obj);
  if (!looksLikeTool) return null;
  // 名字必须能对上（精确 / 规范化相等 / 足够像），否则交给调用方纠错
  const matched = fuzzyToolName(name, toolNames);
  const args = parseArgs(
    fn?.arguments ?? obj.args ?? obj.arguments ?? obj.parameters ?? obj.input ?? obj.params ?? {}
  );
  return { name: matched || name, rawName: name, matched: Boolean(matched), args };
}

/**
 * 第 2/3 层：从 content 文本里抠出工具调用。
 * @returns {{calls:Array<{name:string,rawName:string,args:object}>, matched:boolean}}
 */
export function extractToolCalls(text, toolNames) {
  if (!text || typeof text !== 'string') return { calls: [], matched: false };
  const cleaned = text.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const candidates = [];

  // 整体就是 JSON 的情况
  const trimmed = cleaned.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const v = JSON.parse(trimmed);
      if (Array.isArray(v)) candidates.push(...v);
      else candidates.push(v);
    } catch {
      /* 走扫描 */
    }
  }

  // 嵌在文本里的 JSON
  if (!candidates.length) {
    for (const chunk of scanJsonObjects(cleaned)) {
      try {
        const v = JSON.parse(chunk);
        candidates.push(v);
      } catch {
        /* ignore */
      }
    }
  }

  const calls = [];
  const seen = new Set();
  for (const c of candidates) {
    const picked = pickCallObject(c, toolNames);
    if (!picked) continue;
    const key = `${picked.name}|${JSON.stringify(picked.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(picked);
  }
  return { calls, matched: calls.length > 0 && calls.every((c) => c.matched) };
}
