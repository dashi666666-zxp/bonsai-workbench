/**
 * 上下文压缩（滚动摘要）
 *
 * 触发：历史 token 估算 > 上下文 * ratio 时，把「最近 keepRecent 条之前」的旧消息
 * 交给模型压成一份结构化摘要，摘要挂在 session.summary（落盘随会话保存），
 * 之后每次请求只用「摘要 + 未压缩的最近消息」，原始消息不删（用户还能翻历史）。
 *
 * 压缩点必须落在 user 消息上：assistant.tool_calls 与 tool 回执是一对，
 * 从中间切开会让 llama.cpp 的模板报错。
 */

import { chatStream, estTokens } from './llamacpp.mjs';

export const CTX_DEFAULTS = {
  enabled: true,
  ratio: 0.72,
  keepRecent: 10,
  summaryChars: 1200,
  maxSourceChars: 14000,
  minMessages: 8,
};

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(Number(n) || lo, hi));
}

export function ctxOptions(cfg) {
  const c = cfg?.ctx || {};
  return {
    enabled: c.enabled !== false,
    ratio: clamp(c.ratio ?? CTX_DEFAULTS.ratio, 0.4, 0.95),
    keepRecent: clamp(c.keepRecent ?? CTX_DEFAULTS.keepRecent, 4, 40),
    summaryChars: clamp(c.summaryChars ?? CTX_DEFAULTS.summaryChars, 200, 4000),
    maxSourceChars: clamp(c.maxSourceChars ?? CTX_DEFAULTS.maxSourceChars, 2000, 60000),
    minMessages: clamp(c.minMessages ?? CTX_DEFAULTS.minMessages, 4, 60),
  };
}

/**
 * 上下文大小。优先级：调用方给的实时值（/props 的 n_ctx，见 llm.ctxSize()）→
 * 启动参数里的 -c → 8192。
 *
 * 为什么要有第一档：外部端点（如 D:\llm\ada 的 8080，n_ctx=131072）的 -c 写在别人的
 * 启动脚本里，本程序的 extraArgs 是空的；只看 -c 会永远按 8192 算阈值，长会话一到
 * ~4k token 就触发一次 27B 摘要调用（每次几秒 + 上千 token），纯浪费且过早丢历史。
 */
export function contextSize(cfg, limit = 0) {
  const live = Math.floor(Number(limit) || 0);
  if (live > 0) return live;
  const m = /(?:^|\s)-c\s+(\d+)/.exec(String(cfg?.llamacpp?.extraArgs || ''));
  return m ? Number(m[1]) : 8192;
}

function messageTokens(m) {
  let n = 6;
  const c = m?.content;
  n += estTokens(typeof c === 'string' ? c : JSON.stringify(c ?? ''));
  if (Array.isArray(m?.images)) n += m.images.length * 1100;
  if (m?.thinking) n += estTokens(m.thinking);
  return n;
}

export function historyTokens(session) {
  const start = Number(session?.summaryUpTo) || 0;
  const live = (session?.messages || []).slice(start);
  let n = estTokens(session?.summary || '');
  for (const m of live) n += messageTokens(m);
  return n;
}

/** 每步请求的估算占用：系统提示 + 摘要 + 消息 + 工具 schema 预留；limit=端点实时 n_ctx（0=未知） */
export function estimateContext(session, cfg, sysPromptChars = 3000, limit = 0) {
  const budget = contextSize(cfg, limit);
  const used = historyTokens(session) + Math.ceil(sysPromptChars / 1.5) + 1200;
  const o = ctxOptions(cfg);
  return { budget, used, ratio: used / Math.max(1, budget), threshold: budget * o.ratio };
}

/**
 * 算压缩计划：压缩点之前的消息 [summaryUpTo, cut) 会被摘要替换。
 * @returns {{should:boolean, cut:number, start:number, used:number, budget:number, reason?:string}}
 */
export function planCompression(session, cfg, limit = 0) {
  const o = ctxOptions(cfg);
  const messages = session?.messages || [];
  const start = Math.max(0, Math.min(Number(session?.summaryUpTo) || 0, messages.length));
  const est = estimateContext(session, cfg, 3000, limit);
  const base = { should: false, cut: start, start, used: est.used, budget: est.budget, ratio: est.ratio };
  if (!o.enabled) return { ...base, reason: '上下文压缩已关闭' };
  if (messages.length - start <= o.minMessages) return { ...base, reason: '历史还短，不需要压缩' };
  if (est.used <= est.budget * o.ratio) return { ...base, reason: '未达到压缩阈值' };

  let cut = messages.length - o.keepRecent;
  if (cut <= start) return { ...base, reason: '最近消息已占满，无法切出可压缩区间' };
  // 找到 <= cut 的最近一条 user 消息做切点
  while (cut > start + 1 && messages[cut]?.role !== 'user') cut -= 1;
  if (messages[cut]?.role !== 'user') {
    let fwd = cut;
    while (fwd < messages.length - 2 && messages[fwd]?.role !== 'user') fwd += 1;
    cut = fwd;
  }
  if (messages[cut]?.role !== 'user' || cut <= start) return { ...base, reason: '找不到安全的切点（user 边界）' };
  return { ...base, should: true, cut };
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + `…（共 ${t.length} 字）` : t;
}

/** 旧消息 → 摘要输入（用户/结论/工具名与关键输出，不塞完整 tool JSON） */
export function renderForSummary(m, budget = 500) {
  if (!m) return '';
  if (m.role === 'user') {
    const imgs = Array.isArray(m.images) && m.images.length ? `（附图 ${m.images.length} 张）` : '';
    return `用户：${imgs}${truncate(m.content, budget)}`;
  }
  if (m.role === 'assistant') {
    const calls = Array.isArray(m.tool_calls) && m.tool_calls.length
      ? `（调用工具：${m.tool_calls.map((c) => c.function?.name || c.name || '?').join(', ')}）`
      : '';
    const body = [m.content, m.thinking ? `[思考] ${m.thinking}` : ''].filter(Boolean).join(' ');
    return `助手：${calls}${truncate(body, budget)}`;
  }
  if (m.role === 'tool') return `工具结果（${m.tool_name || '?'}）：${truncate(m.content, Math.floor(budget / 2))}`;
  return '';
}

const SUMMARY_SYSTEM =
  '你是上下文压缩器。把给定的对话历史压成一份后续还能用的中文摘要，只输出摘要正文，不要寒暄、不要引用编号。';

function summaryPrompt(transcript, prior, o) {
  return [
    prior ? `【已有摘要】（更早的历史，已压缩过，保留并合入新摘要）\n${prior}\n` : '',
    `【待压缩的对话历史】（按时间顺序）\n${transcript}\n`,
    '请输出一份不超过 ' + o.summaryChars + ' 字的结构化摘要，必须保留：',
    '1. 用户的目标与约束（原话关键要求、禁止项）；',
    '2. 已经查实的事实与结论，以及各自来源（文件名/路径/命令/链接，原样保留）；',
    '3. 已完成的改动与产物（文件路径、命令结果、数字与哈希原样保留）；',
    '4. 仍未完成或待确认的事项；',
    '5. 后续继续工作时最容易踩的坑。',
    '原文里的数字、路径、版本号、错误信息必须逐字保留，不要概括成「若干」「约」；不要编造历史里没有的内容。',
  ].filter(Boolean).join('\n');
}

/**
 * 执行一次压缩（调用模型；失败不影响主流程，由调用方决定是否报错）。
 * @param {{session:object, cfg:object, emit?:Function, signal?:AbortSignal, ctxLimit?:number}} o
 *   ctxLimit = 端点实时上下文（/props 的 n_ctx），0/不传则退回 -c / 8192
 */
export async function compressSession({ session, cfg, emit, signal, ctxLimit = 0 }) {
  const plan = planCompression(session, cfg, ctxLimit);
  if (!plan.should) {
    return { ok: false, skipped: true, reason: plan.reason, used: plan.used, budget: plan.budget, ratio: plan.ratio };
  }
  const o = ctxOptions(cfg);
  const older = session.messages.slice(plan.start, plan.cut);
  const lines = [];
  let chars = 0;
  for (const m of older) {
    const line = renderForSummary(m);
    if (!line) continue;
    if (chars + line.length > o.maxSourceChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  if (!lines.length) {
    return { ok: false, skipped: true, reason: '可压缩区间没有有效文本', used: plan.used, budget: plan.budget };
  }

  const body = {
    model: session.model || cfg.model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: summaryPrompt(lines.join('\n'), session.summary || '', o) },
    ],
    stream: true,
    options: { temperature: 0.1 },
    max_tokens: Math.min(900, o.summaryChars * 2),
    think: false,
  };

  let out = '';
  try {
    for await (const chunk of chatStream(body, signal)) {
      out += chunk?.message?.content || '';
    }
  } catch (e) {
    if (signal?.aborted) return { ok: false, aborted: true, reason: '压缩被中止' };
    return { ok: false, error: `压缩调用失败：${e?.message || e}` };
  }

  const summary = out.replace(/^#+\s*/gm, '').trim();
  if (!summary) return { ok: false, error: '模型没有返回摘要内容' };

  const before = plan.used;
  session.summary = summary;
  session.summaryUpTo = plan.cut;
  session.summaryAt = Date.now();
  session.summaryMeta = {
    covered: plan.cut - plan.start,
    before,
    budget: plan.budget,
    summaryChars: summary.length,
    model: body.model,
  };
  const after = historyTokens(session);
  const res = {
    ok: true,
    before,
    after,
    budget: plan.budget,
    covered: plan.cut - plan.start,
    remaining: session.messages.length - plan.cut,
    summaryChars: summary.length,
    summary,
  };
  if (emit) emit({ type: 'ctx_compressed', ...res, summary: undefined });
  return res;
}

/** 拼进 system prompt 的摘要块 */
export function summaryBlock(session) {
  if (!session?.summary) return '';
  const n = Number(session.summaryUpTo) || 0;
  return `【历史对话摘要】（更早的 ${n} 条消息已压缩，原始记录用户仍可翻看；摘要里的路径/数字是已核实事实）\n${session.summary}`;
}
