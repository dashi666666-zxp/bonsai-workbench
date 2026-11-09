/**
 * 资料块与引用校验（减少幻觉的关键一环）
 *
 * 两件事：
 *   1. buildGroundBlock —— 把检索到的块编号成 [S1]…[Sn]，并写清引用规则；
 *   2. verifyAnswer —— 事后校验：引用的编号必须真实存在、有资料时必须引用、
 *      引号里逐字摘录的内容必须能在资料里找到（找不到只记警告，不硬判失败，
 *      因为模型可能引用的是用户原话或常识短语）。
 */

const CITE_RE = /\[S(\d+)\]/g;
const QUOTE_RE = /「([^「」\n]{10,})」|“([^“”\n]{10,})”/g;
const ABSTAIN_RE =
  /资料(?:不足|中没有|里没有|未提及|未涉及|没有提到)|无法(?:从|依据|根据)资料|未(?:在|能在)资料(?:中|里)?(?:找到|查到)|没有(?:找到|检索到)(?:相关)?(?:资料|内容|信息)|知识库(?:中|里)?(?:没有|未|不含)/;

export function toSources(chunks) {
  return (chunks || []).map((c, i) => ({
    id: `S${i + 1}`,
    file: c.file,
    heading: c.heading || '',
    startLine: c.startLine,
    endLine: c.endLine,
    score: Number(c.score) || 0,
    chars: String(c.text || '').length,
  }));
}

/** 拼进 system prompt 的资料块；没有命中时返回空串（不污染提示词） */
export function buildGroundBlock(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) return '';
  const lines = [
    '【知识库检索资料】以下片段来自本地知识库，是回答这个问题最可信的事实来源（按相关度排序）：',
  ];
  chunks.forEach((c, i) => {
    lines.push('');
    lines.push(`[S${i + 1}] ${c.file}${c.heading ? ` · ${c.heading}` : ''} · 行 ${c.startLine}-${c.endLine}`);
    lines.push(String(c.text || '').trim());
  });
  lines.push(
    '',
    '【引用规则】',
    '1. 回答只依据上面的资料（以及工具刚刚返回的真实结果）；资料没写的内容不要补，也不要凭记忆编造。',
    '2. 每个结论后面用 [S1]、[S1][S3] 这样的编号标注出处；引用编号必须来自上面出现过的编号。',
    '3. 资料不足以回答时，直接说「资料不足」，并说明缺什么，不要猜。',
    '4. 上面的资料已由系统检索好，优先直接作答：不要用 run_command / list_dir / search_files 去文件系统里另找答案，也不要重复 rag_search；只有资料明显不含所需内容时才最多再补 1 次 rag_search。',
    '5. 只有在确实需要写入文件或执行外部动作时才调用其他工具；一次问答应在 2 步内结束。'
  );
  return lines.join('\n');
}

/**
 * @param {string} content 模型最终答复
 * @param {object[]} chunks 本次注入的资料块
 * @param {{citeRequired?:boolean}} [opts]
 */
export function verifyAnswer(content, chunks, opts = {}) {
  const text = String(content || '');
  const list = Array.isArray(chunks) ? chunks : [];
  const citeRequired = opts.citeRequired !== false;
  const valid = new Set(list.map((_, i) => `S${i + 1}`));
  const cites = [...new Set([...text.matchAll(CITE_RE)].map((m) => `S${m[1]}`))];
  const invalid = cites.filter((c) => !valid.has(c));
  const abstained = ABSTAIN_RE.test(text);
  const reasons = [];
  const warnings = [];

  if (invalid.length) reasons.push(`引用了不存在的资料编号 ${invalid.join('、')}（本次只有 S1–S${list.length}）`);
  if (citeRequired && list.length && !cites.length && !abstained) reasons.push('没有标注任何 [S#] 出处');

  const squash = (s) => String(s || '').replace(/\s+/g, '');
  const pool = squash(list.map((c) => c.text || '').join('\n'));
  const quotes = [];
  for (const m of text.matchAll(QUOTE_RE)) quotes.push(m[1] || m[2]);
  const unverified = pool ? quotes.filter((q) => !pool.includes(squash(q))) : [];
  if (unverified.length) warnings.push(`有 ${unverified.length} 处引号内容未能与资料逐字对上`);

  return {
    ok: reasons.length === 0,
    cites,
    invalid,
    abstained,
    quoteCount: quotes.length,
    unverified: unverified.slice(0, 2),
    reasons,
    warnings,
  };
}
