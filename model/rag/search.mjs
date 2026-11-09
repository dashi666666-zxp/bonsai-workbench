/**
 * BM25 词法检索（零依赖、零 GPU）
 *
 * 为什么不用 embedding：本机 8GB 显存已被 27B 模型占 7.6GB，再加载 embedding
 * 模型会直接抢显存；而知识库多是文档/代码，词法检索（含中文双字）足够用。
 * 接口保持独立——以后要加向量召回，只需在这里做混合排序，agent/API 不动。
 */

import { queryTokens, tokenize } from './tokens.mjs';

const K1 = 1.2;
const B = 0.75;
const HEADING_BOOST = 1.6; // 标题命中额外加权的「一个 idf」

function idfOf(df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/**
 * @param {object} index buildIndex 的产物
 * @param {string} query
 * @param {{k?:number, maxChars?:number, minScore?:number}} [opts]
 */
export function searchChunks(index, query, opts = {}) {
  const t0 = Date.now();
  const k = Math.max(1, Math.min(Number(opts.k) || 6, 50));
  const maxChars = Math.max(200, Number(opts.maxChars) || 5200);
  const minScore = Number.isFinite(opts.minScore) ? Number(opts.minScore) : 0.05;
  const n = index.chunks.length;
  const qts = queryTokens(query);
  const result = { query, tokens: qts.length, matched: 0, total: n, chunks: [], chars: 0, tookMs: 0 };
  if (!n || !qts.length) {
    result.tookMs = Date.now() - t0;
    return result;
  }

  const avgLen = index.avgLen || 1;
  const df = index.df || {};
  const scored = [];
  for (let ci = 0; ci < n; ci += 1) {
    const chunk = index.chunks[ci];
    const tf = chunk.tf;
    if (!tf) continue;
    let score = 0;
    let hit = 0;
    for (const term of qts) {
      const f = tf[term];
      if (!f) continue;
      hit += 1;
      const idf = idfOf(df[term] || 0, n);
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * chunk.len) / avgLen));
    }
    if (!hit) continue;
    // 覆盖率：命中词占查询词的比例，防止长文档靠单个高频词压过精准短块
    score *= 0.6 + (0.4 * hit) / qts.length;
    scored.push({ ci, score, hit });
  }
  scored.sort((a, b) => b.score - a.score);
  result.matched = scored.length;

  // 标题命中加权：只对头部候选算，避免全量分词开销
  const head = scored.slice(0, Math.max(k * 8, 40));
  for (const s of head) {
    const chunk = index.chunks[s.ci];
    if (!chunk.heading) continue;
    const ht = new Set(tokenize(chunk.heading));
    for (const term of qts) {
      if (!ht.has(term)) continue;
      s.score += HEADING_BOOST * idfOf(df[term] || 0, n);
      break;
    }
  }
  head.sort((a, b) => b.score - a.score);

  let chars = 0;
  for (const s of head) {
    if (s.score < minScore && result.chunks.length) break;
    const chunk = index.chunks[s.ci];
    if (result.chunks.length && chars + chunk.text.length > maxChars) continue;
    result.chunks.push({ ...chunk, score: Math.round(s.score * 1000) / 1000 });
    chars += chunk.text.length;
    if (result.chunks.length >= k) break;
  }
  result.chars = chars;
  result.tookMs = Date.now() - t0;
  return result;
}
