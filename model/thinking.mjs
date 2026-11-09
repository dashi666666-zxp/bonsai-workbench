/**
 * 思考路径（thinking path）——把一条固定的推理路径内化进 agent 主循环。
 *
 * 选型与出处（2026-11-08 调研 GitHub）：
 *   - Plan-and-Solve Prompting（ACL 2023, AGI-Edgerunners/Plan-and-Solve-Prompting）
 *     「先弄懂问题并制定计划，再按计划一步步执行」——解决「上来就答、漏步骤」。
 *   - Chain-of-Verification（Meta CoVe, ritun16/chain-of-verification）
 *     「先草稿，再生成核验问题，再逐条核验，最后修正」——解决「编完不自查」。
 *   - 12-Factor Agents #8 Own your control flow（humanlayer/12-factor-agents）
 *     阶段与顺序由代码掌控，不指望模型自觉——所以这里既有提示词也有代码阶段。
 *
 * 落成一条路径：计划 → 取证 → 作答 → 自检（简称 PSV）。
 *   计划：开跑前单独一次小调用产出 2-5 步计划（失败就退回确定性计划）。
 *   取证：沿用现有工具循环与 RAG 自动检索（这一步本来就是 agent 的强项）。
 *   作答：要求结论先行，引用真实资料编号。
 *   自检：收尾检查答复是否给了结论/依据/自检段；缺什么记进回执。
 *
 * 本模块只放纯函数（可单测）；调用 LLM 的部分在 agent.mjs 里（复用 chatStream）。
 */

export const THINKING_PATH = {
  id: 'psv',
  name: '计划 → 取证 → 作答 → 自检',
  stages: [
    { key: 'plan', label: '计划' },
    { key: 'ground', label: '取证' },
    { key: 'answer', label: '作答' },
    { key: 'verify', label: '自检' },
  ],
  sources: [
    'https://github.com/AGI-Edgerunners/Plan-and-Solve-Prompting',
    'https://github.com/ritun16/chain-of-verification',
    'https://github.com/humanlayer/12-factor-agents',
  ],
};

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 配置 → 生效选项（缺省全开） */
export function thinkingOptions(cfg) {
  const t = cfg?.thinking || {};
  return {
    enabled: t.enabled !== false,
    planCall: t.planCall !== false,
    maxPlanSteps: clampInt(t.maxPlanSteps, 2, 8, 5),
    planMaxTokens: clampInt(t.planMaxTokens, 64, 400, 180),
    planTimeoutMs: clampInt(t.planTimeoutMs, 3000, 120000, 30000),
    requireSelfCheck: t.requireSelfCheck === true,
  };
}

const RULES = [
  '按固定路径办事：计划 → 取证 → 作答 → 自检，不要跳步。',
  '1. 计划：先想清「要回答什么、需要哪些证据、怎么算做完」，按【本轮计划】执行。',
  '2. 取证：需要文件/网页/知识库/命令时调用工具；知识库资料已在下面给出就直接用，不要重复检索。',
  '3. 作答：结论先行。有【知识库检索资料】时，每个结论后面标 [S#]；资料里没有的直接说「资料不足」。',
  '4. 自检：最终答复正文末尾另起一段，以「自检：」开头，写清三件事——引用是否齐全、哪些结论没有证据、边界/未验证项。自检不是复述答案。',
];

/** system prompt 片段：路径 + 本轮计划 */
export function buildThinkingBlock(cfg, plan) {
  const opt = thinkingOptions(cfg);
  if (!opt.enabled) return '';
  const lines = ['【思考路径 · 计划→取证→作答→自检（PSV）】', ...RULES];
  const steps = Array.isArray(plan?.steps) ? plan.steps.filter(Boolean).slice(0, opt.maxPlanSteps) : [];
  if (steps.length) {
    lines.push('', '【本轮计划】');
    steps.forEach((s, i) => lines.push(`${i + 1}) ${s}`));
  }
  return lines.join('\n');
}

/** 规划用的请求（只让模型出计划，不让它作答） */
export function planRequest({ task, sources } = {}) {
  const t = String(task || '').trim().slice(0, 800);
  const src = (Array.isArray(sources) ? sources : []).slice(0, 6);
  const lines = [
    `任务：${t || '（未记录任务文本）'}`,
    '',
    '请给出 2-5 步执行计划，要求：',
    '- 第一步说明要回答清楚什么；',
    '- 中间步骤说明用哪些资料/工具取证（已在知识库命中的资料可直接用）；',
    '- 最后一步是自检（引用、数字、边界）。',
    '只输出编号列表，不要解释，不要作答。',
  ];
  if (src.length) {
    lines.push('', '已命中的知识库资料：');
    for (const s of src) lines.push(`- [${s.id}] ${s.file} · ${s.heading || ''} 行 ${s.startLine}-${s.endLine}`);
  }
  return lines.join('\n');
}

const PLAN_LINE = /^\s*(?:[-*+]|\d+[.)、])\s*(.+)$/;

/** 解析模型输出的计划；解析不出就返回空数组（调用方退回 fallbackPlan） */
export function parsePlan(text, maxSteps = 5) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(PLAN_LINE);
    if (!m) continue;
    const step = m[1].replace(/\*\*/g, '').trim();
    if (!step || step.length < 2) continue;
    out.push(step.length > 120 ? step.slice(0, 120) + '…' : step);
    if (out.length >= maxSteps) break;
  }
  return out;
}

/** 规划调用失败/超时/输出为空时的确定性计划（保证阶段仍然存在） */
export function fallbackPlan({ rag } = {}) {
  const hasSources = Boolean(rag?.sources?.length);
  const steps = hasSources
    ? ['读【知识库检索资料】，确定哪些 [S#] 能回答任务', '依据资料作答，每个结论标注 [S#]；资料不足就明说', '自检引用编号与边界，未验证项写清']
    : ['确认任务目标与验收口径', '按需调用工具取证，记录来源', '作答并自检：结论、证据、未验证项'];
  return { steps, source: 'fallback' };
}

/** 收尾自检：答复是否给了结论 / 依据 / 自检段（软判据，进回执与事件） */
export function checkAnswerPath(answer, { requireSelfCheck = false } = {}) {
  const text = String(answer || '');
  const hasConclusion = /(^|\n)\s*#{0,4}\s*结论[:：]|(^|\n)\s*结论[:：]/.test(text) || /^\s*结论[:：]/m.test(text);
  const hasBasis = /\[\s*S\d+\s*\]|依据[:：]|根据|资料来源|引用/.test(text);
  const hasSelfCheck = /(^|\n)\s*(?:#{0,4}\s*)?自检[:：]/.test(text);
  const missing = [];
  if (!hasConclusion) missing.push('结论段');
  if (!hasBasis) missing.push('依据/引用');
  if (requireSelfCheck && !hasSelfCheck) missing.push('自检段');
  return {
    ok: missing.length === 0,
    hasConclusion,
    hasBasis,
    hasSelfCheck,
    missing,
    requireSelfCheck: Boolean(requireSelfCheck),
  };
}

/** 把计划压成一行（日志/回执用） */
export function planOneLine(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) return '';
  return steps.map((s, i) => `${i + 1}) ${s}`).join(' ');
}
