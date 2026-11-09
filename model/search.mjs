/**
 * 联网搜索（零依赖）。
 *
 * 本机实测（2026-11-08，Node fetch）：
 *   - DuckDuckGo（html/lite/api）在本机网络下 fetch failed（被拦），但保留为首选后端，
 *     换网络时可能可用；失败立刻回落到 Bing。
 *   - Bing 网页版可用（HTTP 200，<li class="b_algo"> 结构稳定）⇒ 事实上的默认后端。
 *   - Brave / Searx 同 DDG，被拦。
 *
 * 只做「搜索 + 摘要」，正文仍由 web_fetch 抓，避免把整个网页塞进上下文。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const DDG_URL = 'https://lite.duckduckgo.com/lite/?q=';
const BING_URL = 'https://www.bing.com/search?q=';

/** 后端注册表：名字 → { 搜索 URL 前缀, 解析器, 额外 query 参数 } */
const ENGINES = {
  duckduckgo: { base: DDG_URL, parse: parseDuckDuckGo, suffix: '' },
  bing: { base: BING_URL, parse: parseBing, suffix: '&setlang=zh-CN&count=20' },
};

// 上次成功的后端（sticky 优先）：本机实测只有 Bing 通，DDG 每次必超时 ~10 s，
// 记忆住就直接先打 Bing，不再为 DDG 白等一轮。
let preferred = null;

// 结果缓存：同一搜索词 5 分钟内复用，避免模型重试同一 query 反复付网络时间。
const CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 32;

/** 候选后端顺序：显式锁单后端，或 auto 下的 sticky 顺序（bing → duckduckgo） */
export function resolveEngines(engine) {
  const e = String(engine || 'auto').trim().toLowerCase();
  if (e === 'bing') return ['bing'];
  if (e === 'duckduckgo' || e === 'ddg') return ['duckduckgo'];
  const all = ['bing', 'duckduckgo'];
  return preferred && all.includes(preferred) ? [preferred, ...all.filter((x) => x !== preferred)] : all;
}

/** 测试用：清掉 sticky 与缓存 */
export function resetSearchState() {
  preferred = null;
  CACHE.clear();
}

export function searchCacheSize() {
  return CACHE.size;
}

function cachePut(key, val) {
  CACHE.set(key, val);
  while (CACHE.size > CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    CACHE.delete(oldest);
  }
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ensp: ' ', emsp: ' ', thinsp: ' ', middot: '·', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  times: '×', divide: '÷', deg: '°', plusmn: '±', copy: '©', reg: '®',
};

/** 解开 HTML 实体（含 &#183; / &#x2F; 这类数字实体） */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' '));
}

function absolute(url, base) {
  try {
    return new URL(decodeEntities(url), base).toString();
  } catch {
    return '';
  }
}

/** Bing 有时把结果包成 /ck/a?...&u=a1<base64url>，这里解回真实 URL */
function unwrapBing(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)bing\.com$/i.test(u.hostname) || u.pathname !== '/ck/a') return url;
    const b = u.searchParams.get('u') || '';
    if (!b.startsWith('a1')) return url;
    const raw = Buffer.from(b.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//i.test(raw) ? raw : url;
  } catch {
    return url;
  }
}

/** DuckDuckGo lite 结果页 → [{title,url,snippet}] */
export function parseDuckDuckGo(html) {
  const text = String(html ?? '');
  const out = [];
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*class=['"]?result-link['"]?[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...text.matchAll(/<td[^>]*class=['"]?result-snippet['"]?[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
    stripTags(m[1])
  );
  let i = 0;
  for (const m of text.matchAll(linkRe)) {
    const url = absolute(m[1], 'https://duckduckgo.com');
    const title = stripTags(m[2]);
    if (!url || !title) continue;
    out.push({ title, url, snippet: snippets[i] || '' });
    i += 1;
  }
  return out;
}

/** Bing 结果页 → [{title,url,snippet}] */
export function parseBing(html) {
  const text = String(html ?? '');
  const out = [];
  for (const block of text.split(/<li class="b_algo"/).slice(1)) {
    const h = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!h) continue;
    const url = unwrapBing(absolute(h[1], 'https://www.bing.com'));
    const title = stripTags(h[2]);
    if (!url || !/^https?:\/\//i.test(url) || !title) continue;
    const p =
      block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title, url, snippet: p ? stripTags(p[1]) : '' });
  }
  return out;
}

function dedupe(list, limit) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const key = it.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchHtml(url, timeoutMs) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/**
 * 联网搜索：按后端顺序尝试，第一个有结果的胜出。
 * @param {string} query
 * @param {{count?:number, timeoutMs?:number, engine?:'auto'|'bing'|'duckduckgo'}} opts
 * @returns {Promise<{ok:boolean, engine?:string, results?:Array<{title,url,snippet}>, error?:string, tried?:string[], cached?:boolean}>}
 */
export async function searchWeb(query, { count = 8, timeoutMs = 12000, engine = 'auto' } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, error: '搜索词不能为空' };
  const limit = Math.min(Math.max(Number(count) || 8, 1), 15);
  const order = resolveEngines(engine);
  const key = `${order.join(',')}|${limit}|${q.toLowerCase()}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return { ok: true, engine: hit.engine, results: hit.results, tried: hit.tried, cached: true };
  }
  const tried = [];
  let lastErr = '';
  for (const name of order) {
    const spec = ENGINES[name];
    if (!spec) continue;
    tried.push(name);
    try {
      // auto 模式下 DDG 只给短超时兜底：本机网络基本必失败，别让 10 s 白花
      const t = name === 'duckduckgo' && order.length > 1 ? Math.min(timeoutMs, 6000) : timeoutMs;
      const html = await fetchHtml(spec.base + encodeURIComponent(q) + spec.suffix, t);
      const results = dedupe(spec.parse(html), limit);
      if (results.length) {
        preferred = name;
        cachePut(key, { at: Date.now(), engine: name, results, tried });
        return { ok: true, engine: name, results, tried };
      }
      lastErr = `${name}: 解析不到结果（页面 ${html.length} 字节）`;
    } catch (e) {
      lastErr = `${name}: ${e?.name === 'TimeoutError' ? '超时' : e?.message || e}`;
    }
  }
  return { ok: false, error: lastErr || '所有搜索后端都失败', tried };
}

/** 搜索结果 → 给模型看的紧凑文本 */
export function formatResults(query, results, engine, cached = false) {
  const lines = [`搜索「${query}」· 来源 ${engine || '-'}${cached ? '（缓存）' : ''} · ${results.length} 条`];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet.slice(0, 240)}`);
  });
  lines.push('（摘要不足以回答时，用 web_fetch 抓取具体链接）');
  return lines.join('\n');
}
