import fs from 'node:fs';
import path from 'node:path';
import { SESSION_DIR, ensureDirs } from './config.mjs';

const ID_RE = /^s_[a-z0-9]{4,40}$/;

export function newSession(model) {
  return {
    id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: '新会话',
    model: model || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
}

function fileOf(id) {
  if (!ID_RE.test(String(id || ''))) throw new Error('非法会话 id');
  return path.join(SESSION_DIR, id + '.json');
}

export function saveSession(session) {
  ensureDirs();
  session.updatedAt = Date.now();
  if (!session.title || session.title === '新会话') {
    const first = session.messages.find((m) => m.role === 'user');
    if (first) {
      const t = String(first.content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (t) session.title = t;
    }
  }
  fs.writeFileSync(fileOf(session.id), JSON.stringify(session), 'utf8');
  return session;
}

export function getSession(id) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
}

export function listSessions() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(SESSION_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
      out.push({
        id: s.id,
        title: s.title || '新会话',
        model: s.model || '',
        count: (s.messages || []).length,
        createdAt: s.createdAt || 0,
        updatedAt: s.updatedAt || 0,
      });
    } catch {
      /* 坏档跳过 */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function deleteSession(id) {
  try {
    fs.unlinkSync(fileOf(id));
    return true;
  } catch {
    return false;
  }
}
