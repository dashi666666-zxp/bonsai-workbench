import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../model/agent.mjs';
import { createAgentRuntime } from '../model/agents.mjs';
import { newSession, getSession, saveSession } from '../model/store.mjs';
import { loadConfig, DATA_DIR, RECEIPT_DIR } from '../model/config.mjs';
import { runPluginHooks } from '../model/plugins.mjs';
import { appendDaily } from '../model/memory.mjs';
import { writeReceipt, writeInterruptedReceipts } from '../model/receipt.mjs';
import * as durable from '../model/durable.mjs';
import { emitEvent } from './events.mjs';

const runs = new Map();
const KEEP_MS = 10 * 60 * 1000;
const APPROVAL_TIMEOUT_MS = 180 * 1000;
const RESUME_HINT = '（上一次运行被中断，请接着原来的任务；如果已经完成就直接给出最终答复。）';

function mergeRunCfg(base, overrides = {}) {
  const cfg = structuredClone(base);
  for (const k of ['model', 'think', 'permission', 'approval', 'workspace', 'maxSteps', 'temperature', 'agentsEnabled', 'maxAgents', 'durable', 'webSearchEngine']) {
    if (overrides[k] !== undefined) cfg[k] = overrides[k];
  }
  for (const k of ['thinking', 'receipt', 'rag', 'ctx', 'memory']) {
    if (overrides[k] && typeof overrides[k] === 'object') cfg[k] = { ...cfg[k], ...overrides[k] };
  }
  if (overrides.tokenSaver) cfg.tokenSaver = { ...cfg.tokenSaver, ...overrides.tokenSaver };
  return cfg;
}

function waitApproval(run, callId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      run.pending.delete(callId);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    run.pending.set(callId, (v) => {
      clearTimeout(timer);
      run.pending.delete(callId);
      resolve(v);
    });
  });
}

function newRunId() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 装配一个 run 的 emit：进内存环形缓冲 + 落盘 + 广播 SSE */
function makeEmit(run) {
  return (ev) => {
    const full = {
      ...ev,
      runId: run.runId,
      sessionId: run.sessionId,
      agentId: ev.agentId || null,
      at: Date.now(),
      seq: ++run.seq,
    };
    run.events.push(full);
    if (run.events.length > 3000) run.events.shift();
    if (run.durable) durable.appendRunEvent(run.runId, full);
    emitEvent(full);
  };
}

function makeRun({ runId, session, cfg, seq = 0 }) {
  const run = {
    runId,
    sessionId: session.id,
    session,
    cfg,
    status: 'running',
    startedAt: Date.now(),
    seq,
    events: [],
    controller: new AbortController(),
    pending: new Map(),
    steer: [],
    durable: cfg.durable !== false,
    agents: null,
  };
  runs.set(runId, run);
  run.emit = makeEmit(run);
  return run;
}

async function executeRun(run) {
  try {
    await runLoop(run);
  } catch (e) {
    run.status = 'error';
    run.error = e?.message || String(e);
    run.endedAt = Date.now();
    try {
      saveSession(run.session);
    } catch {
      /* 会话落盘失败不阻断回执 */
    }
    try {
      if (run.durable) durable.updateRunRecord(run.runId, { status: 'error', error: run.error, endedAt: run.endedAt });
    } catch {
      /* 存档失败不阻断 */
    }
    try {
      run.emit?.({ type: 'run_end', status: 'error', error: run.error });
    } catch {
      /* 广播失败不阻断 */
    }
    await finishReceipt(run);
  } finally {
    scheduleCleanup(run);
  }
}

/** run 主体：跑 agent、收尾、广播、写回执；异常由 executeRun 兜底 */
async function runLoop(run) {
  const { session, cfg, emit } = run;
  const agents = createAgentRuntime({ cfg, emit, runId: run.runId });
  run.agents = agents;

  emit({
    type: 'run_start',
    model: cfg.model,
    permission: cfg.permission,
    think: Boolean(cfg.think),
    resumed: Boolean(run.resumed),
  });

  let result;
  try {
    result = await runAgent({
      session,
      cfg,
      emit,
      signal: run.controller.signal,
      requestApproval: (callId) => waitApproval(run, callId),
      agents,
      takeSteer: () => run.steer.shift() || null,
    });
  } catch (e) {
    result = { status: 'error', error: e?.message || String(e) };
  }

  // 父体没正常结束（报错/被停）就一起收掉子体，避免后台孤儿
  if (result.status !== 'done') agents.stopAll();

  saveSession(session);
  run.status = result.status;
  run.error = result.error || null;
  run.endedAt = Date.now();
  if (run.durable) {
    durable.updateRunRecord(run.runId, {
      status: result.status,
      error: result.error || null,
      endedAt: run.endedAt,
    });
  }
  emit({ type: 'run_end', status: result.status, error: result.error || null });

  // 记忆分层：每次 run 结束自动记一条每日日志（纯记账、不调模型；写失败不影响 run）
  try {
    const steps = run.events.reduce((n, e) => n + (e.type === 'step' ? 1 : 0), 0);
    const secs = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
    const task = String(run.task || '（无任务）').replace(/\s+/g, ' ').slice(0, 80);
    appendDaily({ cfg, text: `${task} → ${run.status}（${steps} 步，${secs} s，${run.runId}）` });
  } catch {
    /* 记忆层异常不影响 run 终态 */
  }

  // run 收尾钩子（插件：回执生成等）。旁路动作，慢/抛异常都不影响 run 的终态。
  try {
    await runPluginHooks('runEnd', {
      runId: run.runId,
      sessionId: run.sessionId,
      task: run.task || '',
      status: run.status,
      error: run.error,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      model: cfg.model,
      permission: cfg.permission,
      think: Boolean(cfg.think),
      resumed: Boolean(run.resumed),
      events: run.events,
      session,
      cfg,
      dataDir: DATA_DIR,
    });
  } catch {
    /* 钩子层自己已兜异常；这里只防未来改动漏兜 */
  }

  // 强制回执：主流程收尾（不是插件），失败也有最小回执兜底。
  await finishReceipt(run);
}

/** 清理：run 结束后在内存里保 KEEP_MS 供前端回看 */
function scheduleCleanup(run) {
  const t = setTimeout(() => {
    const cur = runs.get(run.runId);
    if (cur && cur.status !== 'running') runs.delete(run.runId);
  }, KEEP_MS);
  t.unref?.();
}

/**
 * 每次 run 结束必须写回执（done/stopped/error/中断补齐都走这里）。
 * 放在插件钩子之后：内置回执是权威格式，插件写同路径的文件会被覆盖。
 */
async function finishReceipt(run) {
  if (run.receipt) return run.receipt;
  const cfg = run.cfg || loadConfig();
  if (cfg.receipt?.enabled === false) return null;
  try {
    const out = writeReceipt({
      runId: run.runId,
      sessionId: run.sessionId,
      task: run.task || '',
      status: run.status,
      error: run.error || null,
      model: cfg.model,
      permission: cfg.permission,
      think: Boolean(cfg.think),
      resumed: Boolean(run.resumed),
      startedAt: run.startedAt,
      endedAt: run.endedAt || Date.now(),
      events: run.events,
      session: run.session,
      cfg,
    });
    run.receipt = { mdPath: out.mdPath, jsonPath: out.jsonPath, bytes: out.bytes, statusText: out.statusText, at: Date.now() };
    if (run.durable) {
      try {
        durable.updateRunRecord(run.runId, { receipt: out.mdPath });
      } catch {
        /* 存档失败不阻断 */
      }
    }
    try {
      run.emit?.({ type: 'receipt', runId: run.runId, md: out.mdPath, json: out.jsonPath, bytes: out.bytes, statusText: out.statusText });
    } catch {
      /* 广播失败不阻断 */
    }
    return run.receipt;
  } catch (e) {
    // 磁盘/序列化异常时写最小回执，保证「结束必有回执」不被静默破坏
    run.receipt = { error: e?.message || String(e), at: Date.now() };
    try {
      fs.mkdirSync(RECEIPT_DIR, { recursive: true });
      const mdPath = path.join(RECEIPT_DIR, `${run.runId}.md`);
      fs.writeFileSync(
        mdPath,
        `# 回执报告 · ${run.runId}\n\n**结论**：❌ 回执生成失败 — ${run.error || '未知错误'}\n\n- 状态：${run.status}\n- 错误：${run.receipt.error}\n- 时间：${new Date().toISOString()}\n`,
        'utf8'
      );
      run.receipt.mdPath = mdPath;
    } catch {
      /* 连最小回执都写不了就只留事件 */
    }
    try {
      run.emit?.({ type: 'receipt', runId: run.runId, error: run.receipt.error, md: run.receipt.mdPath || '' });
    } catch {
      /* ignore */
    }
    return run.receipt;
  }
}

/* ---------------- 对外 ---------------- */

/** 服务启动时调用：把上次没跑完的 run 标成 interrupted，并清理过旧记录 */
export function initRuns() {
  const interrupted = durable.markInterrupted();
  durable.pruneRuns();
  // 进程重启中断的 run 也要有回执（「每次结束必须有回执」包括崩溃场景）
  const receipts = writeInterruptedReceipts(interrupted);
  return { interrupted: interrupted.map((r) => r.runId), receipts: receipts.map((r) => r.mdPath) };
}

export function listRuns() {
  return [...runs.values()].map((r) => ({
    runId: r.runId,
    sessionId: r.sessionId,
    status: r.status,
    startedAt: r.startedAt,
    agents: r.agents ? r.agents.list().map((a) => ({ agentId: a.agentId, name: a.name, status: a.status })) : [],
  }));
}

/** 落盘的 run 历史（含 interrupted），前端用来显示中断提示 */
export function recentRuns(limit = 20) {
  return durable.listRunRecords(limit).map((r) => ({
    runId: r.runId,
    sessionId: r.sessionId,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt || 0,
    model: r.model || '',
    text: (r.text || '').slice(0, 120),
    error: r.error || null,
    live: runs.has(r.runId),
  }));
}

export function getRun(runId) {
  return runs.get(runId) || null;
}

export function startRun({ sessionId, text, images, overrides }) {
  // 单飞闸：8GB 卡上两个 27B 请求并行会把 prefill 拖到 20 tok/s（实测两 slot 并发 3 分钟出不了第一个 token），
  // 且刷新页面会丢前端的 runningRunId，故闸必须放在服务端。要并行就自己写多实例，不在这里赌显存。
  const active = [...runs.values()].find((r) => r.status === 'running');
  if (active) {
    return {
      error: '已有任务在跑，等它跑完或先点「停止」再发（8GB 显存跑不了两个并发请求）',
      busy: true,
      runId: active.runId,
      sessionId: active.sessionId,
    };
  }
  const cfg = mergeRunCfg(loadConfig(), overrides || {});
  let session = sessionId ? getSession(sessionId) : null;
  if (!session) session = newSession(cfg.model);
  if (cfg.model) session.model = cfg.model;

  const body = String(text || '');
  const imgs = Array.isArray(images) ? images : [];
  const userMsg = { role: 'user', content: body, ts: Date.now() };
  if (imgs.length) userMsg.images = imgs;
  session.messages.push(userMsg);
  saveSession(session);

  const runId = newRunId();
  session.runId = runId;
  saveSession(session);

  const run = makeRun({ runId, session, cfg });
  run.task = body.slice(0, 2000) || (imgs.length ? `（图片 ×${imgs.length}）` : '');
  if (run.durable) {
    durable.writeRunRecord({
      runId,
      sessionId: session.id,
      model: cfg.model,
      text: (body || (imgs.length ? `（图片 ×${imgs.length}）` : '')).slice(0, 2000),
      permission: cfg.permission,
      think: Boolean(cfg.think),
      status: 'running',
      startedAt: run.startedAt,
      updatedAt: Date.now(),
    });
  }
  executeRun(run);
  return { runId, sessionId: session.id };
}

/** 续跑一个中断的 run：沿用原会话与其全部消息，追加一条「接着干」的提示 */
export function resumeRun(runId) {
  const existing = runs.get(runId);
  if (existing) return { error: '这个 run 还在内存里，直接看它的进度', runId };
  const active = [...runs.values()].find((r) => r.status === 'running');
  if (active) return { error: '已有任务在跑，等它跑完或先点「停止」再续跑', busy: true, runId: active.runId };
  const rec = durable.readRunRecord(runId);
  if (!rec) return { error: '没有这个 run 的存档' };
  const session = getSession(rec.sessionId);
  if (!session) return { error: '原会话已被删除，无法续跑' };

  const cfg = mergeRunCfg(loadConfig(), {});
  session.model = session.model || rec.model || cfg.model;
  session.runId = runId;
  session.messages.push({ role: 'user', content: RESUME_HINT, ts: Date.now(), resume: true });
  saveSession(session);

  const prev = durable.readRunEvents(runId);
  const seq = prev.reduce((n, e) => Math.max(n, Number(e.seq) || 0), 0);
  const run = makeRun({ runId, session, cfg, seq });
  run.resumed = true;
  run.task = String(rec.text || '').slice(0, 2000) || RESUME_HINT;

  durable.updateRunRecord(runId, { status: 'running', error: null, resumedAt: Date.now() });
  executeRun(run);
  return { runId, sessionId: session.id };
}

export function stopRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status !== 'running') return false;
  for (const resolve of run.pending.values()) resolve(false);
  run.pending.clear();
  run.agents?.stopAll();
  run.controller.abort();
  return true;
}

export function approveRun(runId, callId, allow) {
  const run = runs.get(runId);
  if (!run) return false;
  const resolve = run.pending.get(callId);
  if (!resolve) return false;
  resolve(Boolean(allow));
  return true;
}

/** 人工直接给正在跑的 run 追加要求（不进模型训练，只在步边界注入） */
export function steerRun(runId, text) {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: 'run 不存在或已回收' };
  if (run.status !== 'running') return { ok: false, error: `run 状态是 ${run.status}，不能追加` };
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '内容为空' };
  run.steer.push(t);
  run.emit({ type: 'steer_queued', text: t, source: 'user' });
  return { ok: true };
}

export function runAgents(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  return run.agents ? run.agents.list() : [];
}

export function messageAgent(runId, agentId, text) {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: 'run 不存在或已回收' };
  if (!run.agents) return { ok: false, error: '这个 run 没有子智能体运行时' };
  try {
    return { ok: true, text: run.agents.message(agentId, text) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function runEvents(runId) {
  const run = runs.get(runId);
  if (run) return run.events;
  const persisted = durable.readRunEvents(runId);
  return persisted.length ? persisted : null;
}
