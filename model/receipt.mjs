/**
 * 内置回执报告（run receipt）——每次 run 结束必须产出一份。
 *
 * 为什么不是插件：插件可禁用、可装错、钩子抛异常就没了；这里是主流程的收尾步骤，
 * 包在 try/catch 里，失败还会写一份「最小回执」，保证「每次结束都有回执」这条承诺。
 *
 * 格式对齐 Lead 的交付汇报：标题 → 一句话结论（结论先行）→ 元信息表 →
 *   结论 / 做了什么 / 验收证据 / 边界与未验证 / 下一步 / 复跑。
 *
 * 落盘：<数据目录>/receipts/<runId>.md（人看）与 <runId>.json（机器看）。
 * 中断的 run 在下次进程启动时由 initRuns() 补齐（见 writeInterruptedReceipts）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, RECEIPT_DIR, ensureDirs } from './config.mjs';
import { readRunRecord, readRunEvents } from './durable.mjs';
import { getSession } from './store.mjs';

export const RECEIPT_VERSION = '1.0.0';
const RUN_ID_RE = /^r_[a-z0-9]{4,40}$/;
const MAX_TASK_CHARS = 2000;
const MAX_RESULT_CHARS = 6000;
const MAX_OUTPUT_CHARS = 240;

const STATUS_TEXT = {
  done: '完成',
  stopped: '已停止',
  error: '出错',
  interrupted: '已中断',
  running: '进行中',
};

/* ---------------- 小工具 ---------------- */

function two(n) {
  return String(n).padStart(2, '0');
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${(s % 60).toFixed(0)} s`;
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + `…（共 ${t.length} 字）` : t;
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function cell(s) {
  return oneLine(s).replace(/\|/g, '\\|');
}

function num(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtArgs(args) {
  if (args == null) return '';
  if (typeof args !== 'object') return clip(String(args), MAX_OUTPUT_CHARS);
  try {
    return clip(JSON.stringify(args), MAX_OUTPUT_CHARS);
  } catch {
    return '(参数不可序列化)';
  }
}

/* ---------------- 事件归纳 ---------------- */

export function summarizeEvents(events) {
  const out = {
    steps: 0,
    toolCalls: [],
    usage: { promptEval: 0, evalCount: 0, evalMs: 0, totalMs: 0, tps: 0 },
    firstDeltaAt: 0,
    firstContentAt: 0,
    assistant: '',
    plan: null,
    thinkingVerify: null,
    rag: null,
    ragMiss: '',
    ragVerify: null,
    ctxCompressed: null,
    approvals: 0,
  };
  const starts = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    switch (ev.type) {
      case 'step':
        out.steps += 1;
        break;
      case 'delta':
        if (!out.firstDeltaAt) out.firstDeltaAt = ev.at || 0;
        if (ev.kind === 'content' && !out.firstContentAt) out.firstContentAt = ev.at || 0;
        break;
      case 'tool_start':
        starts.set(ev.callId, { name: ev.name, args: ev.args });
        break;
      case 'tool_end': {
        const st = starts.get(ev.callId) || {};
        out.toolCalls.push({
          callId: ev.callId,
          name: ev.name || st.name || '(未知工具)',
          ok: ev.ok !== false,
          denied: Boolean(ev.denied),
          ms: Number(ev.ms) || 0,
          args: st.args,
          output: clip(oneLine(ev.output), MAX_OUTPUT_CHARS),
        });
        break;
      }
      case 'usage': {
        const u = out.usage;
        u.promptEval += Number(ev.promptEval) || 0;
        u.evalCount += Number(ev.evalCount) || 0;
        u.evalMs += Number(ev.evalMs) || 0;
        u.totalMs += Number(ev.totalMs) || 0;
        u.tps = Number(ev.tps) || u.tps;
        break;
      }
      case 'assistant_done':
        if (oneLine(ev.content)) out.assistant = String(ev.content);
        break;
      case 'thinking_plan':
        out.plan = { steps: Array.isArray(ev.steps) ? ev.steps : [], source: ev.source || '', ms: Number(ev.ms) || 0 };
        break;
      case 'thinking_verify':
        out.thinkingVerify = { ...ev };
        break;
      case 'rag_retrieved':
        out.rag = {
          query: ev.query || '',
          matched: Number(ev.matched) || 0,
          chunks: Number(ev.chunks) || 0,
          chars: Number(ev.chars) || 0,
          tookMs: Number(ev.tookMs) || 0,
          sources: Array.isArray(ev.sources) ? ev.sources : [],
        };
        out.ragMiss = '';
        break;
      case 'rag_miss':
        out.ragMiss = ev.reason || '未命中';
        break;
      case 'rag_verify':
        out.ragVerify = { ...ev };
        break;
      case 'ctx_compressed':
        out.ctxCompressed = { ...ev };
        break;
      case 'approval_request':
        out.approvals += 1;
        break;
      default:
        break;
    }
  }
  return out;
}

function filesTouched(toolCalls) {
  const seen = new Set();
  for (const c of toolCalls) {
    if (!/write|edit|create|append|delete|move|rename/i.test(c.name)) continue;
    const a = c.args || {};
    const p = a.path || a.file_path || a.file || a.from;
    if (typeof p === 'string' && p.trim()) seen.add(p.trim());
  }
  return [...seen];
}

function finalAssistantFromSession(session) {
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role === 'assistant' && oneLine(m.content)) return String(m.content);
  }
  return '';
}

/* ---------------- 回执生成 ---------------- */

function sourceLine(s) {
  return `[${s.id}] ${s.file}${s.heading ? ' · ' + s.heading : ''} 行 ${s.startLine}-${s.endLine}`;
}

export function buildReceipt(ctx = {}) {
  const events = Array.isArray(ctx.events) ? ctx.events : [];
  const s = summarizeEvents(events);
  const startedAt = Number(ctx.startedAt) || Number(events[0]?.at) || Number(ctx.endedAt) || Date.now();
  const endedAt = Number(ctx.endedAt) || Number(events[events.length - 1]?.at) || Date.now();
  const status = String(ctx.status || 'done');
  const statusText = STATUS_TEXT[status] || status;
  const task = clip(String(ctx.task || ''), MAX_TASK_CHARS).trim();
  const answer = s.assistant || finalAssistantFromSession(ctx.session) || '';
  const failed = s.toolCalls.filter((c) => !c.ok && !c.denied).length;
  const denied = s.toolCalls.filter((c) => c.denied).length;
  const files = filesTouched(s.toolCalls);
  const firstDelta = s.firstDeltaAt ? s.firstDeltaAt - startedAt : 0;
  const firstAnswer = s.firstContentAt ? s.firstContentAt - startedAt : 0;
  const durationMs = Math.max(0, endedAt - startedAt);

  // 一句话结论（结论先行）：状态 + 结果摘要
  const resultOne = oneLine(answer);
  let head;
  if (status === 'done') head = resultOne ? clip(resultOne, 220) : '模型没有产出最终文本，可能全部动作已由工具完成';
  else if (status === 'stopped') head = '任务被手动停止' + (resultOne ? `（已产出部分答复：${clip(resultOne, 120)}）` : '（无最终答复）');
  else if (status === 'interrupted') head = '进程重启导致运行中断，已从落盘数据补写本回执';
  else head = `运行出错：${oneLine(ctx.error) || '未给出原因'}`;

  // 结论正文
  let conclusion;
  if (status === 'done') conclusion = answer ? clip(answer, MAX_RESULT_CHARS) : '（本次 run 没有最终文本答复；可查看下面的工具调用与事件。）';
  else if (status === 'stopped') conclusion = '任务被手动停止。' + (answer ? `\n\n已产出的部分答复：\n\n${clip(answer, MAX_RESULT_CHARS)}` : '');
  else if (status === 'interrupted') conclusion = '上一次进程在运行中被终止（刷新/重启/崩溃）。原始任务与已产生的事件已落盘，可点「继续」续跑。' + (answer ? `\n\n中断前最后一条答复：\n\n${clip(answer, 1200)}` : '');
  else conclusion = `错误：${ctx.error || '未给出原因'}` + (answer ? `\n\n出错前的答复：\n\n${clip(answer, MAX_RESULT_CHARS)}` : '');

  // 「做了什么」：计划 → 取证 → 工具 → 自检
  const rows = [];
  if (s.plan) {
    rows.push({
      stage: '计划',
      action: `${s.plan.source === 'llm' ? '模型规划' : '确定性兜底'} ${s.plan.steps.length} 步`,
      detail: s.plan.steps.map((x, i) => `${i + 1}) ${x}`).join(' '),
      result: s.plan.steps.length ? 'ok' : '空计划',
    });
  }
  if (s.rag) {
    rows.push({
      stage: '取证',
      action: `知识库命中 ${s.rag.matched} 条 → 取 ${s.rag.chunks} 块`,
      detail: s.rag.sources.slice(0, 6).map(sourceLine).join('；'),
      result: 'ok',
    });
  } else if (s.ragMiss) {
    rows.push({ stage: '取证', action: '知识库未命中', detail: s.ragMiss, result: 'miss' });
  }
  s.toolCalls.forEach((c, i) => {
    rows.push({
      stage: '执行',
      action: `\`${c.name}\` #${i + 1}`,
      detail: fmtArgs(c.args) + (c.output ? ` → ${c.output}` : ''),
      result: c.denied ? '拒绝' : c.ok ? 'ok' : '失败',
    });
  });
  if (s.thinkingVerify) {
    const ok = s.thinkingVerify.ok;
    rows.push({
      stage: '自检',
      action: ok ? '答复结构完整' : `缺：${(s.thinkingVerify.missing || []).join('、') || '未知'}`,
      detail: `结论 ${s.thinkingVerify.hasConclusion ? '有' : '无'} · 依据 ${s.thinkingVerify.hasBasis ? '有' : '无'} · 自检段 ${s.thinkingVerify.hasSelfCheck ? '有' : '无'}`,
      result: ok ? 'ok' : 'warn',
    });
  }

  // 验收证据
  const evidence = [];
  if (s.plan) evidence.push(['思考路径 · 计划', `${s.plan.steps.length} 步（${s.plan.source === 'llm' ? '模型生成' : '确定性兜底'}）${s.plan.ms ? ' · ' + fmtDur(s.plan.ms) : ''}`, s.plan.steps.length ? 'PASS' : 'WARN']);
  if (s.rag) evidence.push(['RAG 检索', `命中 ${s.rag.matched} 条 / 取 ${s.rag.chunks} 块 / ${num(s.rag.chars)} 字 · ${fmtDur(s.rag.tookMs)}`, 'PASS']);
  if (s.ragMiss) evidence.push(['RAG 检索', `未命中：${cell(s.ragMiss)}`, 'MISS']);
  if (s.ragVerify) {
    const v = s.ragVerify;
    const desc = v.ok
      ? `通过${v.cites?.length ? '：' + v.cites.join(', ') : ''}`
      : `未通过：${(v.reasons || []).join('；') || '未知原因'}`;
    evidence.push(['引用校验', desc, v.ok ? 'PASS' : 'FAIL']);
  }
  if (s.thinkingVerify) {
    const t = s.thinkingVerify;
    evidence.push(['思考路径 · 自检', t.ok ? '结论/依据/自检段齐全' : `缺 ${(t.missing || []).join('、')}`, t.ok ? 'PASS' : 'WARN']);
  }
  evidence.push(['动作统计', `${s.steps} 步 · ${s.toolCalls.length} 次工具（失败 ${failed} · 拒绝 ${denied}）`, failed ? 'WARN' : 'PASS']);
  evidence.push(['回执落盘', `本文件 + \`${ctx.runId || '—'}.json\``, 'PASS']);

  // 边界与未验证
  const limits = [];
  if (s.plan) limits.push('计划由模型生成，执行中允许调整；回执只记录「计划存在」，不校验每步都完成。');
  if (s.thinkingVerify && !s.thinkingVerify.ok) limits.push(`答复自检缺口：${(s.thinkingVerify.missing || []).join('、')}（软判据，不阻断运行）。`);
  if (s.rag) limits.push('RAG 为 BM25 词法检索（非语义）；引用校验只拦形式（编号存在、有资料必须引用），不证明引用内容一定支持结论。');
  if (!s.toolCalls.length) limits.push('本次未调用工具，结论未做外部取证。');
  if (status !== 'done') limits.push('运行未正常完成，上面的结论只代表已产出的部分。');
  if (s.ctxCompressed) limits.push(`本次压缩了历史：${s.ctxCompressed.before} → ${s.ctxCompressed.after} 条消息，更早内容只剩摘要。`);
  if (!limits.length) limits.push('无已知未验证项（仍建议对关键结论做人工复核）。');

  const next = [];
  if (status === 'done') next.push('结果需要落地时，可继续在同一会话追问，或把结论转成文件/回执附件。');
  else if (status === 'stopped') next.push('重新发送任务或点「继续」；若只是想要部分结果，可复制上面结论。');
  else if (status === 'interrupted') next.push('点「继续」续跑，服务端会沿用原会话与落盘事件。');
  else next.push('先看错误信息与工具调用表定位原因，修复环境后重试；同类任务可先降 maxSteps 或换更小任务。');
  next.push('复跑口径：`GET /api/runs/' + (ctx.runId || '<runId>') + '/events` 看事件；`POST /api/runs/' + (ctx.runId || '<runId>') + '/resume` 续跑（中断/停止时）。');

  /* ---- Markdown ---- */
  const md = [];
  md.push(`# 回执报告 · ${ctx.runId || '（无 runId）'}`);
  md.push('');
  md.push(`**结论**：${status === 'done' ? '✅ 完成' : status === 'stopped' ? '⏹ 已停止' : status === 'interrupted' ? '⚠ 已中断' : '❌ 出错'} — ${head}`);
  md.push('');
  md.push('| 项 | 值 |');
  md.push('| --- | --- |');
  md.push(`| 运行 ID | \`${ctx.runId || '—'}\` |`);
  md.push(`| 会话 | \`${ctx.sessionId || ctx.session?.id || '—'}\` |`);
  md.push(`| 状态 | **${statusText}**${ctx.error ? `（${cell(ctx.error)}）` : ''}${ctx.resumed ? ' · 续跑' : ''} |`);
  md.push(`| 任务 | ${cell(task) || '（未记录任务文本）'} |`);
  md.push(`| 模型 / 权限 | ${cell(ctx.model || '—')} / ${cell(ctx.permission || '—')} · think ${ctx.think === false ? '关' : '开'} |`);
  md.push(`| 时间 | ${fmtTime(startedAt)} → ${fmtTime(endedAt)}（用时 ${fmtDur(durationMs)}） |`);
  md.push(`| 性能 | 首字 ${firstDelta ? fmtDur(firstDelta) : '—'} · 首答 ${firstAnswer ? fmtDur(firstAnswer) : '—'}${s.usage.tps ? ` · ${s.usage.tps} tok/s` : ''} |`);
  md.push(`| 步数 / 工具 | ${s.steps} 步 / ${s.toolCalls.length} 次（失败 ${failed} · 拒绝 ${denied}） |`);
  md.push(`| Token | 提示 ${num(s.usage.promptEval)} · 生成 ${num(s.usage.evalCount)} · 生成耗时 ${fmtDur(s.usage.evalMs)} |`);
  md.push('');
  md.push('## 结论');
  md.push('');
  md.push(conclusion);
  md.push('');
  md.push('## 做了什么');
  md.push('');
  if (!rows.length) md.push('（本次没有可记录的计划/检索/工具动作）');
  else {
    md.push('| # | 阶段 | 动作 | 详情 | 结果 |');
    md.push('| --- | --- | --- | --- | --- |');
    rows.forEach((r, i) => md.push(`| ${i + 1} | ${r.stage} | ${r.action} | ${cell(r.detail)} | ${r.result} |`));
  }
  md.push('');
  md.push('## 验收证据');
  md.push('');
  md.push('| 检查项 | 结果 | 判定 |');
  md.push('| --- | --- | --- |');
  for (const [k, v, r] of evidence) md.push(`| ${cell(k)} | ${cell(v)} | ${r} |`);
  md.push('');
  if (files.length) {
    md.push('## 触及文件');
    md.push('');
    for (const f of files) md.push(`- \`${f}\``);
    md.push('');
  }
  md.push('## 边界与未验证');
  md.push('');
  for (const l of limits) md.push(`- ${l}`);
  md.push('');
  md.push('## 下一步');
  md.push('');
  for (const n of next) md.push(`- ${n}`);
  md.push('');
  md.push('---');
  md.push(`由 bonsai-workbench 内置回执 v${RECEIPT_VERSION} 生成 · ${fmtTime(Date.now())} · 数据目录 \`${DATA_DIR || '—'}\``);
  md.push('');

  const json = {
    version: RECEIPT_VERSION,
    builtin: true,
    generatedAt: Date.now(),
    runId: ctx.runId || '',
    sessionId: ctx.sessionId || ctx.session?.id || '',
    status,
    statusText,
    conclusion: head,
    error: ctx.error || null,
    task,
    model: ctx.model || '',
    permission: ctx.permission || '',
    think: ctx.think !== false,
    resumed: Boolean(ctx.resumed),
    startedAt,
    endedAt,
    durationMs,
    firstDeltaMs: firstDelta || 0,
    firstAnswerMs: firstAnswer || 0,
    steps: s.steps,
    result: oneLine(s.assistant) ? s.assistant : answer,
    usage: s.usage,
    plan: s.plan,
    thinkingVerify: s.thinkingVerify,
    rag: s.rag
      ? { ...s.rag, sources: s.rag.sources }
      : s.ragMiss
        ? { miss: s.ragMiss }
        : null,
    ragVerify: s.ragVerify,
    ctxCompressed: s.ctxCompressed,
    toolCalls: s.toolCalls,
    files,
    eventCount: events.length,
    receipt: { version: RECEIPT_VERSION, md: `${ctx.runId || 'run'}.md`, json: `${ctx.runId || 'run'}.json` },
  };
  return { md: md.join('\n'), json, statusText };
}

/** 写回执（tmp + rename，避免写一半被读到），返回路径信息 */
export function writeReceipt(ctx = {}) {
  ensureDirs();
  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  const { md, json, statusText } = buildReceipt(ctx);
  const runId = String(ctx.runId || '').trim();
  const base = RUN_ID_RE.test(runId) ? runId : 'run-' + Date.now().toString(36);
  const mdPath = path.join(RECEIPT_DIR, `${base}.md`);
  const jsonPath = path.join(RECEIPT_DIR, `${base}.json`);
  fs.writeFileSync(mdPath + '.tmp', md, 'utf8');
  fs.renameSync(mdPath + '.tmp', mdPath);
  fs.writeFileSync(jsonPath + '.tmp', JSON.stringify(json, null, 2), 'utf8');
  fs.renameSync(jsonPath + '.tmp', jsonPath);
  let bytes = 0;
  try {
    bytes = fs.statSync(mdPath).size;
  } catch {
    /* 统计失败不影响回执存在 */
  }
  return { mdPath, jsonPath, bytes, statusText, md, json };
}

/** 从落盘数据重建一次 run 的上下文（进程重启后补回执 / 手动补回执用） */
export function contextFromRunDisk(runId) {
  const id = String(runId || '').trim();
  if (!RUN_ID_RE.test(id)) throw new Error(`非法 runId：${id || '(空)'}`);
  const rec = readRunRecord(id);
  if (!rec) throw new Error(`没有 run 存档：${id}`);
  const events = readRunEvents(id);
  const sid = String(rec.sessionId || '');
  const session = /^s_[a-z0-9]{4,40}$/.test(sid) ? getSession(sid) : null;
  return {
    runId: id,
    sessionId: sid,
    task: rec.text || '',
    status: rec.status || 'done',
    error: rec.error || null,
    model: rec.model || '',
    permission: rec.permission || '',
    think: rec.think !== false,
    startedAt: rec.startedAt || events[0]?.at || Date.now(),
    endedAt: rec.endedAt || rec.updatedAt || events[events.length - 1]?.at || Date.now(),
    events,
    session,
  };
}

/** 启动时为「被中断」的 run 补齐回执；任何一条失败都不阻断启动 */
export function writeInterruptedReceipts(records = []) {
  const written = [];
  for (const rec of records) {
    const runId = rec?.runId;
    if (!runId || !RUN_ID_RE.test(runId)) continue;
    try {
      const mdPathGuess = path.join(RECEIPT_DIR, `${runId}.md`);
      if (fs.existsSync(mdPathGuess)) continue; // 中断前已写过（极少见）就不覆盖
      const out = writeReceipt(contextFromRunDisk(runId));
      written.push({ runId, ...out });
    } catch {
      /* 单条失败不影响其它 */
    }
  }
  return written;
}
