/**
 * Durable run：run 的事件与元数据落盘，进程重启后还能看见、能续跑。
 *
 * 布局：<DATA>/runs/<runId>.json      元数据（status/model/text/sessionId/...）
 *       <DATA>/runs/<runId>.jsonl     事件流（一行一个，seq 递增）
 *
 * 重启时，元数据还是 running 的说明进程死在半路 —— 标成 interrupted，前端给「继续」按钮。
 */
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR, ensureDirs } from './config.mjs';

const ID_RE = /^r_[a-z0-9]{4,40}$/;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KEEP_RECORDS = 200;

function assertId(runId) {
  if (!ID_RE.test(String(runId || ''))) throw new Error(`非法 runId：${runId}`);
  return String(runId);
}

export function metaPath(runId) {
  return path.join(RUN_DIR, assertId(runId) + '.json');
}

export function logPath(runId) {
  return path.join(RUN_DIR, assertId(runId) + '.jsonl');
}

export function writeRunRecord(rec) {
  ensureDirs();
  const file = metaPath(rec.runId);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return rec;
}

export function readRunRecord(runId) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(runId), 'utf8'));
  } catch {
    return null;
  }
}

export function updateRunRecord(runId, patch) {
  const cur = readRunRecord(runId);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  return writeRunRecord(next);
}

export function appendRunEvent(runId, ev) {
  try {
    ensureDirs();
    const file = logPath(runId);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (size > MAX_LOG_BYTES) return; // 单个 run 日志封顶，N 步的巨型输出不再追写
    fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
  } catch {
    /* 落盘失败不影响运行 */
  }
}

export function readRunEvents(runId) {
  try {
    const text = fs.readFileSync(logPath(runId), 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* 半行（进程死在写入中）跳过 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 所有落盘的 run 元数据，新的在前 */
export function listRunRecords(limit = 40) {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(RUN_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(RUN_DIR, f), 'utf8'));
      if (rec?.runId) out.push(rec);
    } catch {
      /* 坏档跳过 */
    }
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out.slice(0, limit);
}

/**
 * 启动时收口：上次进程里没跑完的 run 标成 interrupted。
 * @returns 被标中断的记录
 */
export function markInterrupted() {
  const touched = [];
  for (const rec of listRunRecords(KEEP_RECORDS)) {
    if (rec.status === 'running') {
      const next = updateRunRecord(rec.runId, { status: 'interrupted', error: '进程重启，运行中断', updatedAt: Date.now() });
      if (next) touched.push(next);
    }
  }
  return touched;
}

export function pruneRuns(keep = KEEP_RECORDS) {
  const recs = listRunRecords(10_000);
  for (const rec of recs.slice(keep)) {
    for (const f of [metaPath(rec.runId), logPath(rec.runId)]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 中断的 run（供前端提示「继续」） */
export function interruptedRuns(limit = 10) {
  return listRunRecords(KEEP_RECORDS)
    .filter((r) => r.status === 'interrupted')
    .slice(0, limit);
}
