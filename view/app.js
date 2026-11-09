/* Bonsai Workbench —— 前端（无依赖，直接操作 DOM） */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) => String(s == null ? '' : s);

const state = {
  version: '',
  cfg: {},
  runtime: {},
  current: {},
  models: [],
  sessions: [],
  recentRuns: [],
  receipts: [],
  session: null,
  sessionId: null,
  running: null, // { runId, sessionId, startedAt, firstDeltaAt, firstContentAt, step, tokens, tps, tools }
  lastMetrics: null, // 上一轮跑完后的耗时账，刷新状态时不清空
  attachments: [], // 待发送图片：[{ name, url }]，url 是压过的 data URL
  approvalCallId: null,
  sse: null,
  plugins: [],
  skills: [],
  rag: {},
  ctx: {},
  memory: {},
  configFile: '',
  booted: false,
  // 每个会话最近的知识库/压缩提示（只留 UI 内存，不写回会话文件）：
  // run_end 会用会话原文重渲染 #messages，不兜住的话「知识库命中/引用校验」当场消失。
  notices: {},
};

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}
function stripPrefix(name) {
  return String(name || '').replace(/^llama\//, '');
}

/* ---------------- API ---------------- */
async function api(path, opts) {
  const r = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

/* ---------------- 状态刷新 ---------------- */
async function refreshState() {
  const s = await api('/api/state');
  state.version = s.version;
  state.cfg = s.cfg;
  state.runtime = s.runtime || {};
  state.current = s.current || {};
  state.models = s.models || [];
  state.sessions = s.sessions || [];
  state.recentRuns = s.recentRuns || [];
  state.receipts = s.receipts || [];
  state.runs = s.runs || [];
  state.plugins = s.plugins || [];
  state.skills = s.skills || [];
  state.rag = s.rag || {};
  state.ctx = s.ctx || {};
  state.memory = s.memory || {};
  state.configFile = s.configFile || '';
  state.toolCount = s.toolCount;
  state.llamaUp = Boolean(s.llama?.up);
  state.llamaError = s.llamaError || '';
  renderAll();
}

function renderAll() {
  renderTop();
  renderSessions();
  renderRuns();
  renderModels();
  renderConsole();
  renderReceipts();
  renderSettingsStatic();
}

function renderTop() {
  $('#version').textContent = `v${state.version || '—'}`;
  const conn = $('#conn');
  conn.classList.remove('is-up', 'is-down');
  const upNow = Boolean(state.llamaUp);
  conn.classList.add(upNow ? 'is-up' : 'is-down');
  const rt = state.runtime || {};
  $('#conn-text').textContent = upNow
    ? `端点在线${rt.managed ? ` · 托管 pid ${rt.pid || '—'}` : ' · 外部'}`
    : `端点离线${state.llamaError ? `：${state.llamaError}` : ''}`;
  $('#model-select').value = state.cfg.model || '';
  $('#think').checked = Boolean(state.cfg.think);
  const web = $('#websearch');
  if (web) web.checked = state.cfg.webSearch !== false;
  $('#perm').value = state.cfg.permission || 'workspace-write';
  $('#data-dir').textContent = rt.dataDir || '—';
  $('#work-dir').textContent = state.cfg.workspace || '—';
  const ctx = state.current?.contextLength;
  $('#ctx-info').textContent = ctx ? `ctx ${fmtNum(ctx)}` : 'ctx —';
  $('#tool-count').textContent = `工具 ${state.toolCount ?? '—'}`;
}

function renderModels() {
  const sel = $('#model-select');
  const cur = sel.value;
  sel.innerHTML = '';
  if (!state.models.length) {
    const o = el('option', '', state.llamaError ? '（端点离线）' : '（没有模型）');
    o.value = '';
    sel.append(o);
    return;
  }
  for (const m of state.models) {
    const tags = `${m.contextLength ? ` · ctx ${fmtNum(m.contextLength)}` : ''}${m.caps?.includes('tools') ? ' · 工具' : ''}${m.caps?.includes('vision') ? ' · 视觉' : ''}`;
    const o = el('option', '', `${stripPrefix(m.name)}${tags}`);
    o.value = m.name;
    sel.append(o);
  }
  sel.value = state.cfg.model && state.models.some((m) => m.name === state.cfg.model) ? state.cfg.model : state.models[0].name;
}

/** 正在跑的会话 id：服务端 live runs ∪ 本地 SSE 记下的 running（刷新重连后两者可能只差一步） */
function runningSessionIds() {
  const ids = new Set();
  for (const r of state.runs || []) if (r.status === 'running' && r.sessionId) ids.add(r.sessionId);
  if (state.running && state.running.sessionId) ids.add(state.running.sessionId);
  return ids;
}

/** 会话列表次序：运行中置顶，其余按最近更新（服务端 listSessions 只按 updatedAt，运行中的会话在跑完前不会刷新 updatedAt） */
function sortedSessions() {
  const running = runningSessionIds();
  return [...state.sessions].sort((a, b) => {
    const ra = running.has(a.id) ? 1 : 0;
    const rb = running.has(b.id) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

async function removeSession(s, isRunning) {
  if (isRunning) {
    addSysline('会话正在运行，先点「停止」再删');
    return;
  }
  if (!window.confirm(`删除会话「${s.title || s.id}」？消息不可恢复。`)) return;
  try {
    await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
  } catch (e) {
    addSysline(`删除失败：${e.message}`);
    return;
  }
  delete state.notices[s.id];
  const wasCurrent = state.sessionId === s.id;
  await refreshState();
  if (wasCurrent) {
    state.session = null;
    state.sessionId = null;
    renderSessions();
    renderMessages(null);
  }
  addSysline(`已删除会话「${s.title || s.id}」`);
}

function renderSessions() {
  const box = $('#session-list');
  box.innerHTML = '';
  const running = runningSessionIds();
  if (!state.sessions.length) {
    box.append(el('div', 'empty-row', '还没有会话'));
    return;
  }
  for (const s of sortedSessions()) {
    const isRunning = running.has(s.id);
    const row = el('div', `sess${s.id === state.sessionId ? ' active' : ''}${isRunning ? ' running' : ''}`);
    row.dataset.sessionId = s.id;
    row.append(el('div', 't', s.title || '新会话'));
    const meta = el('div', 'm', `${fmtTime(s.updatedAt)} · ${s.count || 0} 条${s.model ? ` · ${stripPrefix(s.model)}` : ''}`);
    if (isRunning) meta.prepend(el('span', 'sess-badge', '运行中'));
    row.append(meta);
    const del = el('button', 'sess-del', '×');
    del.type = 'button';
    del.disabled = isRunning;
    del.title = isRunning ? '运行中的会话不能删除，先点「停止」' : '删除会话';
    del.setAttribute('aria-label', `删除会话 ${s.title || s.id}`);
    del.onclick = (ev) => {
      ev.stopPropagation();
      removeSession(s, isRunning);
    };
    row.append(del);
    row.onclick = () => selectSession(s.id);
    box.append(row);
  }
}

function renderRuns() {
  const box = $('#run-list');
  box.innerHTML = '';
  const rows = [];
  const live = new Map((state.runs || []).map((r) => [r.runId, r]));
  for (const r of state.recentRuns) rows.push({ ...r, live: r.status === 'running' });
  for (const r of live.values()) {
    if (!rows.some((x) => x.runId === r.runId)) rows.push({ ...r, text: '', live: true });
  }
  rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  $('#run-count').textContent = rows.length ? `${rows.length}` : '';
  if (!rows.length) {
    box.append(el('div', 'empty-row', '还没有运行'));
    return;
  }
  for (const r of rows.slice(0, 20)) {
    const row = el('div', `run-row ${r.status || ''}${r.live ? ' running' : ''}`);
    row.append(el('span', 'st', r.status || '?'));
    row.append(el('span', 'id', r.runId));
    row.title = r.text || r.error || '';
    row.onclick = () => openRun(r);
    box.append(row);
  }
}

function renderConsole() {
  const rt = state.runtime || {};
  $('#c-endpoint').textContent = rt.endpoint || '—';
  $('#c-model').textContent = stripPrefix(state.cfg.model || '—');
  $('#c-ctx').textContent = state.current?.contextLength ? fmtNum(state.current.contextLength) : '—';
  $('#c-args').textContent = rt.extraArgs || '—';
  $('#c-pid').textContent = rt.pid ? String(rt.pid) : rt.managed ? '（托管中）' : '—';
  $('#receipt-count').textContent = state.receipts.length ? `${state.receipts.length} 件` : '';
  renderMetrics();
}

function renderMetrics() {
  const m = state.running || state.lastMetrics || {};
  $('#m-step').textContent = m.step ? String(m.step) : '—';
  $('#m-tokens').textContent = m.tokens ? fmtNum(m.tokens) : '—';
  $('#m-tps').textContent = m.tps ? String(m.tps) : '—';
  $('#m-total').textContent = m.totalMs ? fmtDur(m.totalMs) : '—';
  const first = m.startedAt && m.firstDeltaAt ? m.firstDeltaAt - m.startedAt : null;
  const firstAns = m.startedAt && m.firstContentAt ? m.firstContentAt - m.startedAt : null;
  $('#timing').textContent = `首字 ${first != null ? fmtDur(first) : '—'} · 首答 ${firstAns != null ? fmtDur(firstAns) : '—'} · 总 ${m.totalMs ? fmtDur(m.totalMs) : '—'}`;
}

function renderBadge(status) {
  const b = $('#run-badge');
  b.textContent = status || 'idle';
  b.className = `badge${status === 'running' ? ' running' : status === 'done' ? ' done' : status === 'error' ? ' error' : ''}`;
  $('#btn-stop').disabled = status !== 'running';
  $('#run-state').textContent = status === 'running' ? '运行中…' : status === 'done' ? '完成' : status === 'error' ? '出错' : status === 'stopped' ? '已停止' : '就绪';
}

/* ---------------- 会话与消息渲染 ---------------- */
async function selectSession(id) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.session = s;
    state.sessionId = s.id;
    renderSessions();
    renderMessages(s);
  } catch (e) {
    addSysline(`打开会话失败：${e.message}`);
  }
}

function renderMessages(session) {
  const box = $('#messages');
  box.innerHTML = '';
  const notices = (session && state.notices[session.id]) || [];
  if (!session || !(session.messages || []).length) {
    renderEmpty();
    for (const n of notices) appendSysline(n.text, n.extra);
    scrollBottom();
    return;
  }
  for (const m of session.messages) {
    if (m.role === 'user') box.append(userMsg(m.content, m.images));
    else if (m.role === 'assistant') {
      if (m.thinking) box.append(thinkBlock(m.thinking));
      if (m.content) box.append(assistantMsg(m.content));
    } else if (m.role === 'tool') {
      box.append(toolCard({ name: m.tool_name || 'tool', ok: true, ms: null, output: m.content || '' }));
    }
  }
  // 已经提示过的知识库命中/引用校验，在重渲染后补回来（运行结束后仍然可见）
  for (const n of notices) appendSysline(n.text, n.extra);
  scrollBottom();
}

function renderEmpty() {
  const box = $('#messages');
  box.innerHTML = '';
  const d = el('div', 'empty');
  d.append(el('h1', '', 'Bonsai Workbench'));
  const p = el('p', '', '独立的一条线：只连 llama.cpp / LLMpod 的 OpenAI 兼容端点，不读 Ollama 的模型与接口。');
  d.append(p);
  d.append(el('p', '', '默认端口 4790，数据目录 ~/.bonsai-workbench。左栏新建会话，右侧面板可启停本机 llama-server、查看回执。'));
  const ul = el('ul');
  for (const t of [
    '试试：「用三句话解释三值量化为什么省显存」',
    '让模型自己动手：「列出工作区目录，挑一个大文件总结结构」',
    '接口：POST /api/runs、GET /api/events（SSE）、GET /api/receipts',
  ]) ul.append(el('li', '', t));
  d.append(ul);
  box.append(d);
}

function userMsg(text, images) {
  const m = el('div', 'msg user');
  const b = el('div', 'bubble');
  if (Array.isArray(images) && images.length) {
    const grid = el('div', 'msg-imgs');
    for (const url of images) {
      if (!/^data:image\//i.test(String(url))) continue;
      const im = document.createElement('img');
      im.src = url;
      im.alt = '图片';
      im.onclick = () => window.open(url, '_blank');
      grid.append(im);
    }
    if (grid.childElementCount) b.append(grid);
  }
  if (text) b.append(el('div', 'msg-text', esc(text)));
  m.append(b);
  return m;
}
function assistantMsg(text) {
  const m = el('div', 'msg assistant');
  m.append(el('div', 'who', 'Bonsai'));
  const b = el('div', 'bubble', esc(text));
  m.append(b);
  return m;
}
function thinkBlock(text) {
  const d = el('details', 'think');
  d.append(el('summary', '', '思考过程'));
  const b = el('div', 'body', esc(text));
  d.append(b);
  return d;
}
function toolCard({ name, ok, ms, output }) {
  const wrap = el('div', `tool${ok ? '' : ' err'}`);
  const hd = el('div', 'hd');
  hd.append(el('span', 'nm', name));
  hd.append(el('span', 'meta', `${ok ? 'ok' : 'err'}${ms != null ? ` · ${fmtDur(ms)}` : ''}`));
  const pre = el('pre', '', esc(output || ''));
  pre.hidden = true;
  hd.onclick = () => {
    pre.hidden = !pre.hidden;
  };
  wrap.append(hd, pre);
  return wrap;
}
function appendSysline(text, extra) {
  const line = el('div', 'sysline');
  line.append(el('b', '', text));
  if (extra) line.append(el('span', '', extra));
  $('#messages').append(line);
  scrollBottom();
  return line;
}
function addSysline(text, extra, persist = false) {
  const line = appendSysline(text, extra);
  if (persist && state.sessionId) {
    const list = state.notices[state.sessionId] || (state.notices[state.sessionId] = []);
    list.push({ text, extra: extra || '' });
    if (list.length > 40) list.splice(0, list.length - 40);
  }
  return line;
}
function scrollBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 运行 ---------------- */
function ensureAssistantStream() {
  const box = $('#messages');
  const existing = box.querySelector('.msg.assistant.stream');
  if (existing) return existing;
  const m = el('div', 'msg assistant stream');
  m.append(el('div', 'who', 'Bonsai'));
  const think = el('details', 'think');
  think.hidden = true;
  think.append(el('summary', '', '思考过程'));
  const thinkBody = el('div', 'body');
  think.append(thinkBody);
  const b = el('div', 'bubble');
  m.append(think, b);
  m._think = think;
  m._thinkBody = thinkBody;
  m._bubble = b;
  box.append(m);
  scrollBottom();
  return m;
}

function appendDelta(kind, text) {
  let m = ensureAssistantStream();
  if (kind === 'thinking') {
    m._think.hidden = false;
    m._thinkBody.textContent += text;
  } else {
    m._bubble.textContent += text;
  }
  scrollBottom();
}

/* ---------------- 图片附件（多模态） ---------------- */
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 3000000; // 压缩后单张 data URL 上限（服务端也是 3.5 MB）
const IMG_MAX_SIDE = 1280;

/** 读入图片 → canvas 压到最长边 1280 → JPEG 0.86 的 data URL（模型侧按 ~1100 token 一张算） */
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('不是有效图片'));
      img.onload = () => {
        const scale = Math.min(1, IMG_MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const url = cv.toDataURL('image/jpeg', 0.86);
        if (url.length > MAX_IMAGE_CHARS) return reject(new Error('压缩后仍超过 3 MB，换小一点的图'));
        resolve(url);
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  for (const f of files || []) {
    if (!/^image\//.test(String(f?.type || ''))) {
      addSysline('只支持图片文件', f?.name || '');
      continue;
    }
    if (state.attachments.length >= MAX_IMAGES) {
      addSysline(`最多 ${MAX_IMAGES} 张图片`);
      break;
    }
    try {
      const url = await downscaleImage(f);
      state.attachments.push({ name: f.name || '图片', url });
      renderAttachBar();
    } catch (e) {
      addSysline(`读图失败：${f.name || ''}`, e.message);
    }
  }
}

function renderAttachBar() {
  const bar = $('#attach-bar');
  if (!bar) return;
  bar.innerHTML = '';
  bar.hidden = state.attachments.length === 0;
  state.attachments.forEach((a, i) => {
    const chip = el('div', 'attach-chip');
    const im = document.createElement('img');
    im.src = a.url;
    im.alt = a.name;
    im.title = a.name;
    const x = el('button', 'attach-x', '×');
    x.type = 'button';
    x.title = '移除';
    x.onclick = () => {
      state.attachments.splice(i, 1);
      renderAttachBar();
    };
    chip.append(im, x);
    bar.append(chip);
  });
}

async function send() {
  const input = $('#input');
  const text = input.value.trim();
  const images = state.attachments.map((a) => a.url);
  if (!text && !images.length) return;

  if (state.running) {
    if (images.length) {
      addSysline('运行中只发文字追加要求', '图片请等这一轮结束再发');
      return;
    }
    if (state.running.sessionId !== state.sessionId) {
      addSysline('已有任务在跑（另一个会话）', '等它结束或先点停止');
      return;
    }
    try {
      await api(`/api/runs/${state.running.runId}/steer`, { method: 'POST', body: JSON.stringify({ text }) });
      addSysline('已追加要求', '会在下一步边界生效');
      input.value = '';
      autosize();
    } catch (e) {
      addSysline(`追加失败：${e.message}`);
    }
    return;
  }

  if (!state.sessionId) {
    try {
      const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ model: state.cfg.model }) });
      state.sessions.unshift(s);
      state.session = s;
      state.sessionId = s.id;
      renderSessions();
      renderMessages(s);
    } catch (e) {
      addSysline(`新建会话失败：${e.message}`);
      return;
    }
  }

  const box = $('#messages');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  box.append(userMsg(text, images));
  scrollBottom();
  input.value = '';
  autosize();
  state.attachments = [];
  renderAttachBar();

  try {
    const r = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, text, images }),
    });
    if (!r.runId) throw new Error(r.error || '没有 runId');
    state.running = { runId: r.runId, sessionId: r.sessionId || state.sessionId, startedAt: Date.now(), step: 0 };
    renderBadge('running');
    renderMetrics();
  } catch (e) {
    addSysline(`发送失败：${e.message}`);
  }
}

async function stopRun() {
  if (!state.running) return;
  try {
    await api(`/api/runs/${state.running.runId}/stop`, { method: 'POST', body: '{}' });
  } catch (e) {
    addSysline(`停止失败：${e.message}`);
  }
}

async function openRun(r) {
  if (r.sessionId) await selectSession(r.sessionId);
  if (r.status === 'interrupted') {
    const line = addSysline('这次运行被中断，可以续跑', r.runId);
    const b = el('button', 'mini', '续跑');
    b.onclick = async () => {
      try {
        await api(`/api/runs/${r.runId}/resume`, { method: 'POST', body: '{}' });
        addSysline('已发起续跑', r.runId);
        await refreshState();
      } catch (e) {
        addSysline(`续跑失败：${e.message}`);
      }
    };
    line.append(b);
  }
  if (r.error) addSysline('错误', r.error);
}

/* ---------------- SSE ---------------- */
function connectSSE() {
  if (state.sse) state.sse.close();
  const es = new EventSource('/api/events');
  state.sse = es;
  es.onmessage = (ev) => {
    let e;
    try {
      e = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(e);
  };
  es.onerror = () => {
    /* EventSource 自己会重连；重连后拿一次状态补齐 */
    setTimeout(() => refreshState().catch(() => {}), 1500);
  };
}

function handleEvent(e) {
  if (!e || !e.type) return;
  if (e.sessionId && state.sessionId && e.sessionId !== state.sessionId) return;

  switch (e.type) {
    case 'run_start': {
      state.lastMetrics = null;
      state.running = {
        runId: e.runId,
        sessionId: e.sessionId,
        startedAt: e.at,
        step: 0,
        tokens: 0,
        tps: 0,
      };
      renderBadge('running');
      renderMetrics();
      addSysline('开始运行', `${stripPrefix(e.model || '')}${e.think ? ' · 思考开' : ''}${e.resumed ? ' · 续跑' : ''}`);
      break;
    }
    case 'step':
      if (state.running) state.running.step = e.n;
      renderMetrics();
      $('#run-state').textContent = `第 ${e.n}/${e.max} 步`;
      break;
    case 'delta':
      if (state.running && !state.running.firstDeltaAt) state.running.firstDeltaAt = e.at;
      if (state.running && e.kind === 'content' && !state.running.firstContentAt) state.running.firstContentAt = e.at;
      appendDelta(e.kind, e.text);
      break;
    case 'calls':
      $('#run-state').textContent = `生成工具参数 ${fmtNum(e.bytes)} 字${e.names?.length ? `（${e.names.join(', ')}）` : ''}`;
      break;
    case 'usage':
      if (state.running) {
        state.running.tokens = e.evalCount || 0;
        state.running.tps = e.tps || 0;
      }
      renderMetrics();
      break;
    case 'assistant_done': {
      const m = ensureAssistantStream();
      m._bubble.textContent = e.content || '';
      if (e.thinking) {
        m._think.hidden = false;
        m._thinkBody.textContent = e.thinking;
      }
      break;
    }
    case 'tool_start': {
      const card = toolCard({ name: e.name, ok: true, ms: null, output: '运行中…' });
      card.classList.add('hot');
      card._callId = e.callId;
      $('#messages').append(card);
      $('#tool-stream').prepend(streamRow(e.name, '运行中', ''));
      scrollBottom();
      break;
    }
    case 'tool_end': {
      const cards = [...$('#messages').querySelectorAll('.tool.hot')];
      for (const c of cards) {
        if (c._callId === e.callId) {
          c.classList.remove('hot');
          c.classList.toggle('err', !e.ok);
          c.querySelector('.nm').textContent = e.name;
          c.querySelector('.meta').textContent = `${e.ok ? 'ok' : 'err'}${e.denied ? ' · 拒绝' : ''} · ${fmtDur(e.ms)}`;
          c.querySelector('pre').textContent = e.output || '';
          break;
        }
      }
      const row = streamRow(e.name, e.ok ? 'ok' : 'err', fmtDur(e.ms));
      row.querySelector('.ok, .bad')?.classList.add(e.ok ? 'ok' : 'bad');
      $('#tool-stream').prepend(row);
      scrollBottom();
      break;
    }
    case 'approval_request': {
      state.approvalCallId = e.callId;
      $('#approval-cmd').textContent = JSON.stringify({ tool: e.name, args: e.args }, null, 2);
      $('#modal-approval').hidden = false;
      break;
    }
    case 'steer_applied':
      addSysline('追加要求已生效', e.text);
      break;
    case 'run_end': {
      if (state.running) {
        state.running.totalMs = e.at - state.running.startedAt;
        state.lastMetrics = { ...state.running };
        renderMetrics();
      }
      state.running = null;
      renderBadge(e.status || 'done');
      if (e.error) addSysline('运行错误', e.error);
      $('#modal-approval').hidden = true;
      $('#tool-stream').prepend(streamRow('run_end', e.status || '', ''));
      refreshState()
        .then(() => (state.sessionId ? selectSession(state.sessionId) : null))
        .catch(() => {});
      break;
    }
    case 'rag_retrieved':
      addSysline(
        `知识库命中 ${(e.sources || []).length} 条（${fmtNum(e.chars)} 字 · ${fmtDur(e.tookMs)}）`,
        (e.sources || []).map((s) => `${s.id} ${s.file}:${s.startLine}`).join(' · '),
        true,
      );
      break;
    case 'rag_miss':
      addSysline('知识库未命中', e.reason || '', true);
      break;
    case 'rag_verify':
      if (!e.ok) addSysline('引用校验未通过', (e.reasons || []).join('；'), true);
      else if ((e.cites || []).length) addSysline(`引用校验通过：${e.cites.join(', ')}`, (e.warnings || []).join('；'), true);
      break;
    case 'thinking_stage':
      if (e.stage === 'plan') $('#run-state').textContent = '思考路径 · 制定计划';
      break;
    case 'thinking_plan':
      addSysline(
        `思考路径 · 计划 ${e.source === 'llm' ? `（模型 · ${fmtDur(e.ms)}）` : '（确定性兜底）'}`,
        (e.steps || []).map((s, i) => `${i + 1}) ${s}`).join(' '),
        true,
      );
      break;
    case 'thinking_verify':
      if (e.ok) addSysline('思考路径 · 自检通过', '', true);
      else addSysline('思考路径 · 自检提示', `缺 ${(e.missing || []).join('、')}`, true);
      break;
    case 'receipt':
      if (e.error) addSysline('回执生成失败', e.error, true);
      else addSysline(`回执已生成（${fmtNum(e.bytes)} B）`, e.md || '', true);
      break;
    case 'ctx_compressed':
      addSysline(`历史已压缩：${e.before} → ${e.after} 条消息`, `覆盖 ${e.covered} 条 · 保留 ${e.remaining} 条 · 摘要 ${e.summaryChars} 字`, true);
      break;
    case 'ctx_info':
      addSysline('上下文压缩', e.text || '', true);
      break;
    default:
      break;
  }
}

function streamRow(name, status, ms) {
  const row = el('div', 'row');
  row.append(el('span', status === 'ok' ? 'ok' : status === 'err' ? 'bad' : '', status || ''));
  row.append(el('span', '', name));
  if (ms) row.append(el('span', 'ms', ms));
  return row;
}

/* ---------------- 回执 ---------------- */
function renderReceipts() {
  const box = $('#receipt-list');
  box.innerHTML = '';
  if (!state.receipts.length) {
    box.append(el('div', 'empty-row', '还没有回执（每次 run 结束会自动写）'));
    return;
  }
  for (const r of state.receipts.slice(0, 40)) {
    const row = el('div', 'receipt-row');
    row.append(el('span', 'nm', r.name));
    row.append(el('span', 'sz', `${fmtTime(r.mtime)} · ${(r.bytes / 1024).toFixed(1)}K`));
    row.onclick = async () => {
      try {
        const d = await api(`/api/receipts?name=${encodeURIComponent(r.name)}`);
        const pre = $('#receipt-view');
        pre.hidden = false;
        pre.textContent = d.text || '';
      } catch (err) {
        addSysline(`读回执失败：${err.message}`);
      }
    };
    box.append(row);
  }
}

/* ---------------- 设置 ---------------- */
function renderSettingsStatic() {
  const cfg = state.cfg || {};
  const ll = cfg.llamacpp || {};
  $('#f-host').value = ll.host || '';
  $('#f-autostart').checked = Boolean(ll.autostart);
  $('#f-serverPath').value = ll.serverPath || '';
  $('#f-modelPath').value = ll.modelPath || '';
  $('#f-cudartPath').value = ll.cudartPath || '';
  $('#f-extraArgs').value = ll.extraArgs || '';
  $('#f-mmproj').value = ll.mmproj || '';
  $('#f-endpointMode').value = ll.mode === 'managed' ? 'managed' : 'external';
  $('#f-workspace').value = cfg.workspace || '';
  $('#f-permission').value = cfg.permission || 'workspace-write';
  $('#f-approval').value = cfg.approval || 'auto';
  $('#f-maxSteps').value = cfg.maxSteps ?? 24;
  $('#f-temperature').value = cfg.temperature ?? 0.6;
  $('#f-pluginsEnabled').checked = cfg.pluginsEnabled !== false;
  $('#f-skillsEnabled').checked = cfg.skillsEnabled !== false;
  $('#f-agentsEnabled').checked = cfg.agentsEnabled !== false;
  $('#f-webSearch').checked = cfg.webSearch !== false;
  $('#f-webSearchEngine').value = cfg.webSearchEngine || 'auto';
  const rg = cfg.rag || {};
  $('#f-ragRoot').value = rg.root || '';
  $('#f-ragEnabled').checked = rg.enabled !== false;
  $('#f-ragAuto').checked = rg.autoRetrieve !== false;
  $('#f-ragCite').checked = rg.citeRequired !== false;
  $('#f-ragTopK').value = rg.topK ?? 6;
  $('#f-ragMaxChars').value = rg.maxChars ?? 5200;
  $('#f-chunkSize').value = rg.chunkSize ?? 700;
  $('#f-overlap').value = rg.overlap ?? 120;
  const cx = cfg.ctx || {};
  $('#f-ctxEnabled').checked = cx.enabled !== false;
  $('#f-ctxRatio').value = cx.ratio ?? 0.72;
  $('#f-keepRecent').value = cx.keepRecent ?? 10;
  $('#f-summaryChars').value = cx.summaryChars ?? 1200;
  const mm = cfg.memory || {};
  $('#f-memEnabled').checked = mm.enabled !== false;
  $('#f-memDaily').checked = mm.daily !== false;
  $('#f-memInject').value = mm.injectMaxChars ?? 2200;
  $('#f-mcp').value = JSON.stringify(cfg.mcpServers || {}, null, 2);
  $('#config-file').textContent = state.configFile || '';
  renderRagStats();
  renderMemoryStats();
  renderSettingsLists();
}

/** 设置面板里 RAG / 压缩的实时状态行 */
function renderRagStats() {
  const r = state.rag || {};
  const box = $('#rag-stats');
  if (box) {
    const parts = [r.enabled === false ? 'RAG：已关闭' : 'RAG：开启'];
    if (r.exists) {
      parts.push(`索引 ${fmtNum(r.files)} 文件 / ${fmtNum(r.chunks)} 块`);
      parts.push(`建于 ${r.builtAt ? fmtTime(r.builtAt) : '—'}`);
      if (r.indexBytes) parts.push(`${(r.indexBytes / 1024).toFixed(0)} KB`);
      if (r.rootChanged) parts.push('⚠ 目录已变更，需重建');
    } else {
      parts.push('索引未建立（点「重建索引」）');
    }
    box.textContent = `${parts.join(' · ')}\n目录 ${r.root || '—'}`;
  }
  const c = state.ctx || {};
  const cbox = $('#ctx-stats');
  if (cbox) {
    cbox.textContent = [
      c.enabled === false ? '压缩：关闭' : '压缩：开启',
      `上下文 ${fmtNum(c.contextSize || 0)} tok`,
      `触发 ${Math.round((Number(c.ratio) || 0.72) * 100)}%`,
      `保留 ${c.keepRecent ?? 10} 条`,
      `摘要 ≤${c.summaryChars ?? 1200} 字`,
    ].join(' · ');
  }
}

/** 设置面板里记忆分层的实时状态行 */
function renderMemoryStats() {
  const m = state.memory || {};
  const box = $('#mem-stats');
  if (!box) return;
  if (m.enabled === false) {
    box.textContent = '记忆：已关闭（不注入、不写日志）';
    return;
  }
  const parts = (m.layers || []).map((l) => `${l.label} ${l.count}`);
  box.textContent = `记忆：自动注入 ${m.injectChars || 0} 字符 · ${parts.join(' / ')}\n目录 ${m.dir || '—'}`;
}

/** 「查看记忆」：拉 /api/memory，把五层预览贴到设置面板 */
async function showMemory() {
  const box = $('#mem-view');
  try {
    const r = await api('/api/memory');
    const lines = [`目录 ${r.dir}`, `自动注入 ${r.injectChars} 字符（上限 ${state.cfg?.memory?.injectMaxChars ?? 2200}）`];
    for (const l of r.layers || []) {
      lines.push('', `【${l.label}】${l.injected ? '自动注入' : '按需检索'} · ${l.count} 条${l.chars ? ` · ${l.chars} 字` : ''}`);
      if (!(l.preview || []).length) lines.push('  （空）');
      else for (const e of l.preview) lines.push(`  - [${e.date}] ${e.text}`);
    }
    box.textContent = lines.join('\n');
  } catch (e) {
    box.textContent = `读取记忆失败：${e.message}`;
  }
  box.hidden = false;
}

function renderSettingsLists() {
  const pl = $('#f-plugins');
  pl.innerHTML = '';
  const plugs = state.plugins || [];
  if (!plugs.length) pl.append(el('div', 'empty-row', '没有插件'));
  for (const p of plugs) {
    const row = el('div', 'sess');
    row.append(el('div', 't', `${p.name}${p.version ? ` v${p.version}` : ''}`));
    row.append(el('div', 'm', `${(p.tools || []).length} 工具${(p.hooks || []).length ? ` · 钩子 ${p.hooks.join(',')}` : ''}${p.error ? ` · 错误 ${p.error}` : ''}`));
    const b = el('button', 'mini', p.enabled ? '停用' : '启用');
    b.onclick = async () => {
      try {
        await api('/api/plugins/toggle', { method: 'POST', body: JSON.stringify({ name: p.name, enabled: !p.enabled }) });
        await refreshState();
      } catch (e) {
        addSysline(`插件开关失败：${e.message}`);
      }
    };
    row.append(b);
    pl.append(row);
  }
  // 技能面板信噪比：本机技能库 ~194 条、真正启用 6 条，平铺一列等于不可用。
  // 口径：已启用的排在前面 + 一行计数；未启用的收进可展开小节（默认收起）。
  const sk = $('#f-skills');
  sk.innerHTML = '';
  const allSkills = state.skills || [];
  const usable = (s) => Boolean(s.enabled) && !s.error;
  const onSkills = allSkills.filter(usable);
  const offSkills = allSkills.filter((s) => !usable(s));
  const skillRow = (s) => {
    const row = el('div', 'sess');
    row.append(el('div', 't', s.name));
    const src = String(s.sourceDir || '').split(/[\\/]/).filter(Boolean).pop() || '';
    const meta = usable(s)
      ? [s.chars ? `${s.chars} 字` : '', src].filter(Boolean).join(' · ')
      : s.error
        ? `错误：${s.error}`
        : '已停用';
    row.append(el('div', 'm', meta));
    const b = el('button', 'mini', usable(s) ? '停用' : '启用');
    b.onclick = async () => {
      try {
        await api('/api/skills/toggle', { method: 'POST', body: JSON.stringify({ name: s.name, enabled: !s.enabled }) });
        await refreshState();
      } catch (e) {
        addSysline(`技能开关失败：${e.message}`);
      }
    };
    row.append(b);
    return row;
  };
  sk.append(el('div', 'rag-stats', `技能 ${allSkills.length} 条，已启用 ${onSkills.length} 条`));
  for (const s of onSkills) sk.append(skillRow(s));
  if (offSkills.length) {
    const det = document.createElement('details');
    const sum = el('summary', '', `其余 ${offSkills.length} 条未启用（展开看 / 启用）`);
    det.append(sum);
    for (const s of offSkills) det.append(skillRow(s));
    sk.append(det);
  }
}

async function saveSettings() {
  const note = $('#settings-note');
  const num = (node, dflt) => {
    const v = Number(node.value);
    return Number.isFinite(v) ? v : dflt;
  };
  let mcpServers;
  try {
    mcpServers = JSON.parse($('#f-mcp').value || '{}');
  } catch (e) {
    note.textContent = `MCP JSON 不合法：${e.message}`;
    return;
  }
  const patch = {
    llamacpp: {
      host: $('#f-host').value.trim(),
      autostart: $('#f-autostart').checked,
      serverPath: $('#f-serverPath').value.trim(),
      modelPath: $('#f-modelPath').value.trim(),
      mmproj: $('#f-mmproj').value.trim(),
      mode: $('#f-endpointMode').value,
      cudartPath: $('#f-cudartPath').value.trim(),
      extraArgs: $('#f-extraArgs').value.trim(),
    },
    workspace: $('#f-workspace').value.trim(),
    permission: $('#f-permission').value,
    approval: $('#f-approval').value,
    maxSteps: Number($('#f-maxSteps').value) || 24,
    temperature: Number($('#f-temperature').value),
    pluginsEnabled: $('#f-pluginsEnabled').checked,
    skillsEnabled: $('#f-skillsEnabled').checked,
    agentsEnabled: $('#f-agentsEnabled').checked,
    webSearch: $('#f-webSearch').checked,
    webSearchEngine: $('#f-webSearchEngine').value,
    rag: {
      root: $('#f-ragRoot').value.trim(),
      enabled: $('#f-ragEnabled').checked,
      autoRetrieve: $('#f-ragAuto').checked,
      citeRequired: $('#f-ragCite').checked,
      topK: num($('#f-ragTopK'), 6),
      maxChars: num($('#f-ragMaxChars'), 5200),
      chunkSize: num($('#f-chunkSize'), 700),
      overlap: num($('#f-overlap'), 120),
    },
    ctx: {
      enabled: $('#f-ctxEnabled').checked,
      ratio: num($('#f-ctxRatio'), 0.72),
      keepRecent: num($('#f-keepRecent'), 10),
      summaryChars: num($('#f-summaryChars'), 1200),
    },
    memory: {
      enabled: $('#f-memEnabled').checked,
      daily: $('#f-memDaily').checked,
      injectMaxChars: num($('#f-memInject'), 2200),
    },
    mcpServers,
  };
  try {
    await api('/api/config', { method: 'PATCH', body: JSON.stringify(patch) });
    note.textContent = '已保存。端点设置改动后点「重载插件」不会生效，重启工作台或点「启动端点」应用。';
    await refreshState();
  } catch (e) {
    note.textContent = `保存失败：${e.message}`;
  }
}

/* ---------------- llama.cpp 端点控制 ---------------- */
async function startEndpoint() {
  try {
    const r = await api('/api/llamacpp/start', { method: 'POST', body: '{}' });
    addSysline(r.ok ? `端点已启动${r.pid ? `（pid ${r.pid}）` : ''}` : `端点未就绪：${r.reason || r.error || '未知原因'}`);
    await refreshState();
  } catch (e) {
    addSysline(`启动端点失败：${e.message}`);
  }
}
async function stopEndpoint() {
  try {
    await api('/api/llamacpp/stop', { method: 'POST', body: '{}' });
    addSysline('已请求停止端点');
    await refreshState();
  } catch (e) {
    addSysline(`停止端点失败：${e.message}`);
  }
}

/**
 * 一键切换端点模式：只写 llamacpp.profiles[mode] 那一组字段。
 * 外部端点 = 连别人起的 /v1（如 ada:8080）；本机托管 = 工作台自己拉起 llama-server（如 :8082）。
 */
async function applyEndpointMode() {
  const mode = $('#f-endpointMode').value;
  const note = $('#mode-note');
  note.textContent = mode === 'managed'
    ? '切换中：同步端点配置，然后拉起 llama-server（27B 加载十几秒）…'
    : '切换中：停掉工作台托管的 llama-server（若有），改连外部端点…';
  try {
    const r = await api('/api/llamacpp/mode', { method: 'POST', body: JSON.stringify({ mode }) });
    await refreshState();
    const st = r.status || {};
    const where = r.mode === 'managed' ? '本机托管' : '外部端点';
    note.textContent = !r.ok
      ? `切换失败：${r.reason || '未知原因'}`
      : r.up
        ? `已切到${where}：${st.host || ''}${st.managed ? `（托管 pid ${st.pid}）` : '（端点在线）'}`
        : `已切到${where}：${st.host || ''}，但端点暂不可达：${r.reason || '未知原因'}`;
    addSysline(note.textContent);
  } catch (e) {
    note.textContent = `切换失败：${e.message}`;
    addSysline(note.textContent);
  }
}

/* ---------------- 事件绑定 ---------------- */
function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(180, t.scrollHeight) + 'px';
}

function bind() {
  $('#btn-send').onclick = send;
  // 图片入口三条：按钮选文件 / 直接粘贴 / 拖进输入区
  $('#btn-attach').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => {
    addImageFiles(e.target.files);
    e.target.value = '';
  };
  document.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((i) => String(i.type || '').startsWith('image/'));
    if (!items.length) return;
    e.preventDefault();
    addImageFiles(items.map((i) => i.getAsFile()).filter(Boolean));
  });
  const composer = $('#composer');
  composer.addEventListener('dragover', (e) => {
    e.preventDefault();
    composer.classList.add('drag-over');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.classList.remove('drag-over');
    addImageFiles(e.dataTransfer?.files);
  });
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('#input').addEventListener('input', autosize);
  $('#btn-stop').onclick = stopRun;

  /* ---- 知识库 / 上下文压缩 ---- */
  $('#btn-rag-index').onclick = async () => {
    const box = $('#rag-result');
    box.hidden = false;
    box.textContent = '正在扫描并建索引…';
    try {
      const r = await api('/api/rag/index', {
        method: 'POST',
        body: JSON.stringify({ root: $('#f-ragRoot').value.trim(), rebuild: true }),
      });
      box.textContent = r.ok
        ? `索引完成：${fmtNum(r.files)} 文件 / ${fmtNum(r.chunks)} 块 / ${fmtNum(r.tokens)} 词 / ${(r.indexBytes / 1024).toFixed(1)} KB / ${fmtDur(r.ms)}\n目录：${r.root}${r.truncated ? '\n注意：达到上限，有内容未索引' : ''}`
        : `建索引失败：${r.error || '未知原因'}`;
      await refreshState();
    } catch (e) {
      box.textContent = `建索引失败：${e.message}`;
    }
  };
  $('#btn-rag-search').onclick = async () => {
    const q = $('#rag-q').value.trim();
    if (!q) return;
    const box = $('#rag-result');
    box.hidden = false;
    box.textContent = '检索中…';
    try {
      const r = await api('/api/rag/search', { method: 'POST', body: JSON.stringify({ query: q }) });
      if (!r.ok) {
        box.textContent = `检索失败：${r.reason || '未知原因'}`;
        return;
      }
      const lines = [`检索「${r.query}」· 命中 ${fmtNum(r.matched)} 块 · 取 ${r.chunks.length} 块（${fmtDur(r.tookMs)} · ${fmtNum(r.chars)} 字）`];
      r.chunks.forEach((c, i) => {
        lines.push(`\n[S${i + 1}] ${c.file} · ${c.heading || '(无标题)'} · 行 ${c.startLine}-${c.endLine} · 分 ${Number(c.score).toFixed(3)}`);
        lines.push(String(c.text || '').slice(0, 400));
      });
      box.textContent = lines.join('\n');
    } catch (e) {
      box.textContent = `检索失败：${e.message}`;
    }
  };
  $('#rag-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#btn-rag-search').click();
    }
  });
  $('#btn-compress-now').onclick = async () => {
    if (!state.sessionId) {
      addSysline('先选一个会话再压缩');
      return;
    }
    addSysline('开始压缩当前会话历史…');
    try {
      const r = await api('/api/compress', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId }) });
      if (!r.ok) {
        addSysline(`压缩未执行：${r.error || r.reason || r.skipped || '未知原因'}`);
        return;
      }
      addSysline(`压缩完成：${r.before} → ${r.after} 条消息（覆盖 ${r.covered} 条，摘要 ${r.summaryChars} 字）`);
      await refreshState();
      await selectSession(state.sessionId);
    } catch (e) {
      addSysline(`压缩失败：${e.message}`);
    }
  };
  $('#btn-new-session').onclick = async () => {
    try {
      const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ model: state.cfg.model }) });
      state.sessions.unshift(s);
      state.session = s;
      state.sessionId = s.id;
      renderSessions();
      renderMessages(s);
      $('#input').focus();
    } catch (e) {
      addSysline(`新建会话失败：${e.message}`);
    }
  };
  $('#model-select').onchange = async (e) => {
    try {
      await api('/api/config', { method: 'PATCH', body: JSON.stringify({ model: e.target.value }) });
      state.cfg.model = e.target.value;
      renderConsole();
    } catch (err) {
      addSysline(`切换模型失败：${err.message}`);
    }
  };
  $('#think').onchange = async (e) => {
    try {
      await api('/api/config', { method: 'PATCH', body: JSON.stringify({ think: e.target.checked }) });
      state.cfg.think = e.target.checked;
    } catch (err) {
      addSysline(`切换思考失败：${err.message}`);
    }
  };
  $('#websearch').onchange = async (e) => {
    const on = e.target.checked;
    try {
      await api('/api/config', { method: 'PATCH', body: JSON.stringify({ webSearch: on }) });
      state.cfg.webSearch = on;
      addSysline(on ? '联网搜索已开启：模型可调用 web_search 取实时信息' : '联网搜索已关闭：模型看不到 web_search 工具');
    } catch (err) {
      e.target.checked = !on;
      addSysline(`切换联网搜索失败：${err.message}`);
    }
  };
  $('#perm').onchange = async (e) => {
    try {
      await api('/api/config', { method: 'PATCH', body: JSON.stringify({ permission: e.target.value }) });
      state.cfg.permission = e.target.value;
    } catch (err) {
      addSysline(`切换权限失败：${err.message}`);
    }
  };
  $('#btn-settings').onclick = () => {
    renderSettingsStatic();
    $('#modal-settings').hidden = false;
  };
  $('#btn-close-settings').onclick = () => {
    $('#modal-settings').hidden = true;
  };
  $('#btn-receipts').onclick = () => {
    $('#panel-receipts').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  $('#btn-save-settings').onclick = saveSettings;
  $('#btn-reload-mcp').onclick = async () => {
    try {
      await api('/api/mcp/refresh', { method: 'POST', body: '{}' });
      await refreshState();
      $('#settings-note').textContent = 'MCP 已重连。';
    } catch (e) {
      $('#settings-note').textContent = `MCP 重连失败：${e.message}`;
    }
  };
  $('#btn-refresh-plugins').onclick = async () => {
    try {
      await api('/api/plugins/refresh', { method: 'POST', body: '{}' });
      await refreshState();
      $('#settings-note').textContent = '插件已重载。';
    } catch (e) {
      $('#settings-note').textContent = `插件重载失败：${e.message}`;
    }
  };
  $('#btn-refresh-skills').onclick = async () => {
    try {
      await api('/api/skills/refresh', { method: 'POST', body: '{}' });
      await refreshState();
      $('#settings-note').textContent = '技能已重载。';
    } catch (e) {
      $('#settings-note').textContent = `技能重载失败：${e.message}`;
    }
  };
  $('#btn-mem-view').onclick = showMemory;
  $('#btn-llama-start').onclick = startEndpoint;  $('#btn-llama-stop').onclick = stopEndpoint;
  $('#btn-apply-mode').onclick = applyEndpointMode;
  $('#btn-allow').onclick = async () => {
    if (!state.approvalCallId || !state.running) return;
    try {
      await api(`/api/runs/${state.running.runId}/approve`, { method: 'POST', body: JSON.stringify({ callId: state.approvalCallId, allow: true }) });
    } catch (e) {
      addSysline(`批准失败：${e.message}`);
    }
    $('#modal-approval').hidden = true;
  };
  $('#btn-deny').onclick = async () => {
    if (!state.approvalCallId || !state.running) return;
    try {
      await api(`/api/runs/${state.running.runId}/approve`, { method: 'POST', body: JSON.stringify({ callId: state.approvalCallId, allow: false }) });
    } catch (e) {
      addSysline(`拒绝失败：${e.message}`);
    }
    $('#modal-approval').hidden = true;
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#modal-settings').hidden = true;
      $('#modal-approval').hidden = true;
    }
  });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  bind();
  renderBadge('idle');
  try {
    await refreshState();
    state.booted = true;
  } catch (e) {
    addSysline(`读取状态失败：${e.message}`);
  }
  connectSSE();
  // 默认打开正在跑的会话（与左栏「运行中置顶」同一口径）；没有运行就打开最近会话，再没有就留空态
  const running = (state.runs || []).find((r) => r.status === 'running');
  if (running) {
    // 服务端还有在跑的 run（刷新页面/重连）：把它的会话打开，事件流从下一页开始接
    state.running = { runId: running.runId, sessionId: running.sessionId, startedAt: running.startedAt, step: 0 };
    renderBadge('running');
    await selectSession(running.sessionId);
    addSysline('服务端有一个运行中的任务', running.runId);
  } else if (state.sessions.length) {
    await selectSession(state.sessions[0].id);
  } else {
    renderEmpty();
  }
  $('#input').focus();
}

boot();
