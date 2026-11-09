/**
 * RAG 门面：配置归一 + 检索 + 状态
 *
 * agent 只 import 这一个文件；切片/索引/检索/引用校验都在 rag/ 子模块里，
 * 将来要换向量召回只动 search.mjs，接口不变。
 */

import { buildIndex, indexStatus, loadIndex, ragOptions, resolveRagRoot, RAG_DIR } from './rag/store.mjs';
import { searchChunks } from './rag/search.mjs';
import { buildGroundBlock, toSources, verifyAnswer } from './rag/ground.mjs';

export {
  buildIndex,
  indexStatus,
  loadIndex,
  ragOptions,
  resolveRagRoot,
  RAG_DIR,
  searchChunks,
  buildGroundBlock,
  toSources,
  verifyAnswer,
};

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(Number(n) || lo, hi));
}

export function ragConfig(cfg) {
  const r = cfg?.rag || {};
  return {
    enabled: r.enabled !== false,
    autoRetrieve: r.autoRetrieve !== false,
    citeRequired: r.citeRequired !== false,
    topK: clamp(r.topK ?? 6, 1, 20),
    maxChars: clamp(r.maxChars ?? 5200, 800, 20000),
    root: resolveRagRoot(cfg),
  };
}

export function ragStatus(cfg) {
  const conf = ragConfig(cfg);
  const st = indexStatus();
  return {
    ...st,
    enabled: conf.enabled,
    autoRetrieve: conf.autoRetrieve,
    citeRequired: conf.citeRequired,
    topK: conf.topK,
    maxChars: conf.maxChars,
    root: conf.root,
    rootChanged: Boolean(st.exists && st.root && st.root !== conf.root),
  };
}

/**
 * 检索一次。返回 {ok, chunks, sources, block, ...}；失败时 reason 是给用户看的人话。
 * @param {{cfg:object, query:string, k?:number}} o
 */
export function retrieve({ cfg, query, k }) {
  const conf = ragConfig(cfg);
  const base = { query: String(query || ''), chunks: [], sources: [], block: '', matched: 0, tokens: 0, chars: 0, tookMs: 0 };
  if (!conf.enabled) return { ...base, ok: false, reason: 'RAG 检索已关闭' };
  const q = String(query || '').trim();
  if (q.length < 2) return { ...base, ok: false, reason: '问题太短，不检索' };

  const index = loadIndex();
  if (!index) return { ...base, ok: false, reason: '知识库索引还没建立（设置 → 重建索引）' };
  if (index.root !== conf.root) {
    return { ...base, ok: false, reason: `索引目录与当前知识库目录不一致（索引：${index.root}），请重建索引` };
  }

  const res = searchChunks(index, q, { k: k || conf.topK, maxChars: conf.maxChars });
  const out = {
    ...base,
    ok: res.chunks.length > 0,
    matched: res.matched,
    tokens: (res.tokens || []).length,
    chars: res.chars,
    tookMs: res.tookMs,
    chunks: res.chunks,
    sources: toSources(res.chunks),
    block: buildGroundBlock(res.chunks),
    root: index.root,
    builtAt: index.builtAt,
  };
  if (!out.ok) out.reason = '知识库里没有检索到相关内容';
  return out;
}
