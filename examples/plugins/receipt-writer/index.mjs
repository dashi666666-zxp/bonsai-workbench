/**
 * receipt-writer —— 任务收尾回执插件（钩子型 + 一个手动工具）
 *
 * 挂钩子 `runEnd`：每次 run 结束（done / stopped / error）写两份文件到 <数据目录>/receipts/：
 *   <runId>.md    人看：任务、结果、工具调用、耗时、token
 *   <runId>.json  机器看：结构化同内容
 *
 * 提供工具 `write_receipt {runId?}`：不传则重写本进程最近一次 run 的回执；传 runId 则从
 * <数据目录>/runs/<runId>.{json,jsonl} + <数据目录>/sessions/<sid>.json 重建（进程重启后也能补）。
 *
 * 约定：钩子与工具都只写文件、返回值不影响 run；写盘失败只报错不抛（钩子层也会兜）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_VERSION = '0.1.0';
const RUN_ID_RE = /^r_[a-z0-9]{4,40}$/;
const MAX_TASK_CHARS = 2000;
const MAX_RESULT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 300;

let dataDir = '';
let receiptDir = '';
let lastCtx = null;

function ensureDirs() {
  if (!dataDir) dataDir = process.env.BW_DATA || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.bonsai-workbench');
  if (!receiptDir) receiptDir = process.env.BW_RECEIPT_DIR || path.join(dataDir, 'receipts');
  fs.mkdirSync(receiptDir, { recursive: true });
  return receiptDir;
}

/** 由 workbench 在加载插件时调用（enabled 且有 init 才会调） */
export function init({ dataDir: d }) {
  if (d) dataDir = d;
  return ensureDirs();
}

/* ---------------- 小工具 ---------------- */

function two(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${(s % 60).toFixed(0)} s`;
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + `…（共 ${t.length} 字，已截断）` : t;
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
  return clip(JSON.stringify(args), MAX_OUTPUT_CHARS);
}

/* ---------------- 事件归纳 ---------------- */

export function summarize(events) {
  const out = {
    steps: 0,
    toolCalls: [],
    usage: { promptEval: 0, evalCount: 0, evalMs: 0, totalMs: 0, tps: 0 },
    firstDeltaAt: 0,
    firstContentAt: 0,
    assistant: '',
    calls: 0,
  };
  const starts = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'step') out.steps += 1;
    else if (ev.type === 'delta') {
      if (!out.firstDeltaAt) out.firstDeltaAt = ev.at || 0;
      if (ev.kind === 'content' && !out.firstContentAt) out.firstContentAt = ev.at || 0;
    } else if (ev.type === 'tool_start') {
      starts.set(ev.callId, { name: ev.name, args: ev.args });
    } else if (ev.type === 'tool_end') {
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
    } else if (ev.type === 'usage') {
      const u = out.usage;
      u.promptEval += Number(ev.promptEval) || 0;
      u.evalCount += Number(ev.evalCount) || 0;
      u.evalMs += Number(ev.evalMs) || 0;
      u.totalMs += Number(ev.totalMs) || 0;
      u.tps = Number(ev.tps) || u.tps;
    } else if (ev.type === 'assistant_done' && oneLine(ev.content)) {
      out.assistant = String(ev.content);
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

const STATUS_TEXT = {
  done: '完成',
  stopped: '已停止',
  error: '出错',
  interrupted: '已中断',
  running: '进行中',
};

/* ---------------- 回执生成 ---------------- */

export function buildReceipt(ctx = {}) {
  const events = Array.isArray(ctx.events) ? ctx.events : [];
  const s = summarize(events);
  const startedAt = Number(ctx.startedAt) || Number(events[0]?.at) || Number(ctx.endedAt) || Date.now();
  const endedAt = Number(ctx.endedAt) || Number(events[events.length - 1]?.at) || Date.now();
  const status = String(ctx.status || 'done');
  const statusText = STATUS_TEXT[status] || status;
  const task = clip(String(ctx.task || ''), MAX_TASK_CHARS).trim();
  const answer = s.assistant || finalAssistantFromSession(ctx.session) || '';
  const failed = s.toolCalls.filter((c) => !c.ok).length;
  const denied = s.toolCalls.filter((c) => c.denied).length;
  const files = filesTouched(s.toolCalls);
  const firstDelta = s.firstDeltaAt ? s.firstDeltaAt - startedAt : 0;
  const firstAnswer = s.firstContentAt ? s.firstContentAt - startedAt : 0;

  let result;
  if (status === 'done') result = answer ? clip(answer, MAX_RESULT_CHARS) : '（模型没有产出最终文本答复，可能全部动作都由工具完成）';
  else if (status === 'stopped') result = '任务被手动停止。' + (answer ? `\n\n已产出的部分答复：\n\n${clip(answer, MAX_RESULT_CHARS)}` : '');
  else result = `错误：${ctx.error || '未给出原因'}` + (answer ? `\n\n出错前的答复：\n\n${clip(answer, MAX_RESULT_CHARS)}` : '');

  const lines = [];
  lines.push('# 任务回执');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 运行 ID | \`${ctx.runId || '—'}\` |`);
  lines.push(`| 会话 | \`${ctx.sessionId || ctx.session?.id || '—'}\` |`);
  lines.push(`| 状态 | **${statusText}**${ctx.error ? `（${cell(ctx.error)}）` : ''} |`);
  lines.push(`| 模型 | ${cell(ctx.model || '—')} |`);
  lines.push(`| 权限 / 思考 | ${cell(ctx.permission || '—')} / ${ctx.think === false ? '关' : '开'}${ctx.resumed ? ' · 续跑' : ''} |`);
  lines.push(`| 开始 | ${fmtTime(startedAt)} |`);
  lines.push(`| 结束 | ${fmtTime(endedAt)}（用时 ${fmtDur(endedAt - startedAt)}） |`);
  lines.push(`| 首字 / 首答 | ${firstDelta ? fmtDur(firstDelta) : '—'} / ${firstAnswer ? fmtDur(firstAnswer) : '—'} |`);
  lines.push(`| 步数 / 工具调用 | ${s.steps} / ${s.toolCalls.length}（失败 ${failed} · 拒绝 ${denied}） |`);
  lines.push(
    `| Token | 提示 ${num(s.usage.promptEval)} · 生成 ${num(s.usage.evalCount)} · 生成耗时 ${fmtDur(s.usage.evalMs)}${
      s.usage.tps ? ` · ${s.usage.tps} tok/s` : ''
    } |`
  );
  lines.push('');
  lines.push('## 任务');
  lines.push('');
  lines.push(task ? task.split('\n').map((l) => `> ${l}`).join('\n') : '> （未记录任务文本）');
  lines.push('');
  lines.push('## 结果');
  lines.push('');
  lines.push(result);
  lines.push('');
  lines.push(`## 工具调用（${s.toolCalls.length}）`);
  lines.push('');
  if (!s.toolCalls.length) lines.push('（本次没有调用工具）');
  else {
    lines.push('| # | 工具 | 结果 | 耗时 | 参数 |');
    lines.push('| --- | --- | --- | --- | --- |');
    s.toolCalls.forEach((c, i) => {
      const r = c.denied ? '拒绝' : c.ok ? '成功' : '失败';
      lines.push(`| ${i + 1} | \`${cell(c.name)}\` | ${r} | ${fmtDur(c.ms)} | ${cell(fmtArgs(c.args))} |`);
    });
  }
  lines.push('');
  if (files.length) {
    lines.push('## 触及文件');
    lines.push('');
    for (const f of files) lines.push(`- \`${f}\``);
    lines.push('');
  }
  lines.push('---');
  lines.push(`由插件 receipt-writer v${PLUGIN_VERSION} 生成 · ${fmtTime(Date.now())} · 数据目录 \`${dataDir || '—'}\``);
  lines.push('');

  const json = {
    plugin: 'receipt-writer',
    pluginVersion: PLUGIN_VERSION,
    generatedAt: Date.now(),
    runId: ctx.runId || '',
    sessionId: ctx.sessionId || ctx.session?.id || '',
    status,
    statusText,
    error: ctx.error || null,
    model: ctx.model || '',
    permission: ctx.permission || '',
    think: ctx.think !== false,
    resumed: Boolean(ctx.resumed),
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    firstDeltaMs: firstDelta || 0,
    firstAnswerMs: firstAnswer || 0,
    steps: s.steps,
    task,
    result: oneLine(s.assistant) ? s.assistant : answer,
    usage: s.usage,
    toolCalls: s.toolCalls,
    files,
    eventCount: events.length,
  };
  return { md: lines.join('\n'), json, statusText };
}

/** 写回执，返回 {mdPath, jsonPath} */
export function writeReceipt(ctx = {}) {
  ensureDirs();
  const { md, json } = buildReceipt(ctx);
  const runId = String(ctx.runId || '').trim();
  const base = RUN_ID_RE.test(runId) ? runId : 'run-' + Date.now().toString(36);
  const mdPath = path.join(receiptDir, `${base}.md`);
  const jsonPath = path.join(receiptDir, `${base}.json`);
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');
  return { mdPath, jsonPath };
}

/* ---------------- 从落盘数据重建（手动工具用） ---------------- */

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function contextFromDisk(runId) {
  const id = String(runId || '').trim();
  if (!RUN_ID_RE.test(id)) throw new Error(`非法 runId：${id || '(空)'}`);
  const rec = readJsonFile(path.join(dataDir, 'runs', `${id}.json`));
  if (!rec) throw new Error(`没有 run 存档：${id}`);
  const events = [];
  try {
    const text = fs.readFileSync(path.join(dataDir, 'runs', `${id}.jsonl`), 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t));
      } catch {
        /* 半行跳过 */
      }
    }
  } catch {
    /* 没有事件流也能出回执 */
  }
  const sid = String(rec.sessionId || '');
  const session = /^s_[a-z0-9]{4,40}$/.test(sid) ? readJsonFile(path.join(dataDir, 'sessions', `${sid}.json`)) : null;
  return {
    runId: id,
    sessionId: sid,
    task: rec.text || '',
    status: rec.status || 'done',
    error: rec.error || null,
    startedAt: rec.startedAt || events[0]?.at || Date.now(),
    endedAt: rec.endedAt || rec.updatedAt || events[events.length - 1]?.at || Date.now(),
    model: rec.model || '',
    permission: rec.permission || '',
    think: rec.think !== false,
    events,
    session,
  };
}

/* ---------------- 钩子 / 工具 ---------------- */

export const hooks = {
  async runEnd(ctx) {
    lastCtx = ctx;
    writeReceipt(ctx);
  },
};

export const tools = [
  {
    name: 'write_receipt',
    description: '按 runId 从落盘数据重建并写出任务回执（Markdown+JSON）；不传 runId 则重写最近一次 run 的回执',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '要补写回执的 run ID（形如 r_xxxx）；不传则用最近一次 run' },
      },
    },
    run(args = {}) {
      const runId = String(args.runId || '').trim();
      const ctx = runId ? contextFromDisk(runId) : lastCtx;
      if (!ctx) return { ok: false, output: '还没有可写回执的 run：本进程还没跑过任务，且没传 runId' };
      const { mdPath, jsonPath } = writeReceipt(ctx);
      return `已写回执 ${ctx.runId || ''}\n- ${mdPath}\n- ${jsonPath}`;
    },
  },
];
