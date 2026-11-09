/**
 * 检索用分词（零依赖，词法检索用，不做 embedding）
 *
 * - 拉丁词/数字：连续 [a-z0-9_] 且长度 ≥ 2；
 * - CJK：同时收「单字」与「相邻双字」。双字是中文检索的主力（词边界未知），
 *   单字用于兜底召回（极短查询、专有名词只命中一个字时）。
 *
 * 这套分词与 BM25 一起在 smoke 里用「查询能召回正确文件」反向验证，
 * 不追求语言学正确，只追求召回稳定、可复现。
 */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/gu;
const LATIN_RUN = /[a-z0-9_]+/g;

export function isCjk(ch) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(ch);
}

/** 文档侧：返回带重复的词列表（用于算 tf） */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const m of s.matchAll(LATIN_RUN)) {
    const w = m[0];
    if (w.length >= 2) out.push(w);
  }
  for (const m of s.matchAll(CJK_RUN)) {
    const chars = Array.from(m[0]);
    for (const ch of chars) out.push(ch);
    for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** 查询侧：去重、保序（重复词加权重会被 BM25 的 idf 抹平，去重后更好解释） */
export function queryTokens(text) {
  const seen = new Set();
  const out = [];
  for (const t of tokenize(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 高频虚词单字不进索引，省体积也降噪 */
const STOP_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '就', '都', '而', '及', '或', '被', '把', '这', '那',
  '我', '你', '他', '她', '它', '们', '个', '不', '也', '很', '有', '无', '为', '以', '于',
  '上', '下', '中', '对', '从', '到', '并', '但', '呢', '吗', '啊', '之', '其', '等', '可',
]);

export function isStopChar(ch) {
  return STOP_CHARS.has(ch);
}
