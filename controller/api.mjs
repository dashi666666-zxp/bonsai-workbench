import { loadConfig, saveConfig, configFile, DATA_DIR, RECEIPT_DIR } from '../model/config.mjs';
import {
  listModels,
  listLoaded,
  modelCaps,
  clearCapsCache,
  ensureServer as ensureLlamaServer,
  stopServer as stopLlamaServer,
  statusOf as llamaStatus,
  switchMode as switchLlamaMode,
  probe as llamaProbe,
  ctxSize as llamaCtxLimit,
} from '../model/llm.mjs';
import { allTools } from '../model/tools.mjs';
import { PRESETS } from '../model/permission.mjs';
import { listSessions, getSession, newSession, saveSession, deleteSession } from '../model/store.mjs';
import { syncMcp, mcpStatus } from '../model/mcp.mjs';
import {
  loadPlugins,
  pluginStatus,
  pluginDir,
  pluginToggles,
  setPluginEnabled,
  setAllPluginsEnabled,
  toggleFile as pluginToggleFile,
} from '../model/plugins.mjs';
import {
  loadSkills,
  skillStatus,
  setSkillEnabled,
  setAllSkillsEnabled,
  toggleFile as skillToggleFile,
} from '../model/skills.mjs';
import {
  listRuns,
  recentRuns,
  startRun,
  stopRun,
  approveRun,
  steerRun,
  resumeRun,
  runEvents,
  runAgents,
  messageAgent,
} from './runs.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addClient } from './events.mjs';
import { json, readJsonBody } from './router.mjs';
import { buildIndex as buildRagIndex, ragStatus, retrieve as ragRetrieve } from '../model/rag.mjs';
import { compressSession, contextSize, estimateContext } from '../model/compress.mjs';
import { memoryStats, memoryStatus } from '../model/memory.mjs';

// 版本单一真源 = package.json（此处原先写死字符串，换版本时会漂）
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** 记忆分层在 model/memory.mjs（v0.6.0 起）：本地文件、无向量、无嵌入模型。 */

/**
 * 模型列表：只有一条线（llama.cpp / LLMpod 的 OpenAI 兼容 /v1）。
 * 端点不通时返回空列表 + 可读错误，界面照常可用（设置面板里改端点/启动）。
 */
async function collectModels() {
  const models = [];
  const loaded = [];
  let error = null;
  try {
    models.push(...(await listModels()));
    loaded.push(...(await listLoaded()));
  } catch (e) {
    error = `连不上 llama.cpp 端点：${e?.message || e}`;
  }
  const loadedSet = new Set(loaded.map((l) => l.name));
  for (const m of models) {
    if (!m.caps) {
      const info = await modelCaps(m.name).catch(() => ({ caps: [], contextLength: 0 }));
      m.caps = info.caps;
      m.contextLength = info.contextLength;
    }
    if (m.loaded === undefined) m.loaded = loadedSet.has(m.name);
  }
  return { models, loaded, error };
}

/** 端点 + 本机托管运行时的静态信息（/api/state 用） */
function runtimeInfo(cfg) {
  const st = llamaStatus();
  return {
    endpoint: cfg.llamacpp?.host || '',
    serverPath: cfg.llamacpp?.serverPath || '',
    modelPath: cfg.llamacpp?.modelPath || '',
    extraArgs: cfg.llamacpp?.extraArgs || '',
    mmproj: cfg.llamacpp?.mmproj || '',
    mode: st.mode || 'external',
    managed: Boolean(st.managed),
    pid: st.pid || 0,
    autostart: Boolean(cfg.llamacpp?.autostart),
    lastError: st.lastError || null,
    dataDir: DATA_DIR,
    receiptDir: RECEIPT_DIR,
  };
}

/** 回执目录（插件 receipt-writer 写出的 Markdown/JSON），按修改时间倒序 */
export function listReceipts() {
  const out = [];
  try {
    for (const name of readdirSync(RECEIPT_DIR).sort()) {
      if (!/\.(md|json)$/.test(name)) continue;
      const file = join(RECEIPT_DIR, name);
      try {
        const st = statSync(file);
        out.push({ name, bytes: st.size, mtime: st.mtimeMs });
      } catch {
        /* 读不到就跳过 */
      }
    }
  } catch {
    /* 目录不存在 = 还没有回执 */
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export async function getState() {
  const { models, loaded, error } = await collectModels();
  const cfg = loadConfig();
  const sk = skillStatus();
  // 选中模型必须属于本线：配置里残留的旧模型、或端点换了模型名，都自动切到第一个可用
  if (models.length && (!cfg.model || !models.some((m) => m.name === cfg.model))) {
    cfg.model = models[0].name;
    saveConfig({ model: cfg.model });
  }
  const cur = models.find((m) => m.name === cfg.model) || models[0] || {};
  return {
    version: VERSION,
    cfg,
    configFile: configFile(),
    models,
    loaded,
    llamaError: error,
    llama: { ...llamaStatus(), up: await llamaProbe(800) },
    runtime: runtimeInfo(cfg),
    current: { name: cur.name || '', caps: cur.caps || [], contextLength: cur.contextLength || 0 },
    sessions: listSessions(),
    runs: listRuns(),
    recentRuns: recentRuns(20),
    toolCount: allTools(cfg).length,
    presets: PRESETS,
    mcp: mcpStatus(),
    plugins: pluginStatus(),
    pluginDir: pluginDir(),
    skills: sk.skills,
    skillDir: sk.dirs,
    skillTotals: { total: sk.total, enabled: sk.enabled, scannedAt: sk.scannedAt },
    rag: ragStatus(cfg),
    ctx: { ...cfg.ctx, contextSize: contextSize(cfg, await llamaCtxLimit()) },
    memory: memoryStatus(cfg),
    receipts: listReceipts(),
  };
}

/* ---------------- handlers ---------------- */

export async function hState(req, res) {
  json(res, 200, await getState());
}

export async function hModels(req, res) {
  const { models, loaded, error } = await collectModels();
  json(res, 200, { models, loaded, llamaError: error });
}

export async function hRefreshModels(req, res) {
  clearCapsCache();
  json(res, 200, { ok: true });
}

/* ---------------- 本地知识库（RAG） ---------------- */

export async function hRagStatus(req, res) {
  json(res, 200, ragStatus(loadConfig()));
}

/** POST /api/rag/index { root?, rebuild? } —— 同步构建，返回索引统计 */
export async function hRagIndex(req, res, params, body) {
  try {
    const meta = buildRagIndex({
      cfg: loadConfig(),
      root: body?.root ? String(body.root) : undefined,
      rebuild: body?.rebuild !== false,
    });
    json(res, 200, { ok: true, ...meta });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

/** POST /api/rag/search { query, k? } —— 只给界面看检索过程，不调模型 */
export async function hRagSearch(req, res, params, body) {
  const q = String(body?.query ?? '').trim();
  if (!q) return json(res, 400, { error: 'query 不能为空' });
  const r = ragRetrieve({ cfg: loadConfig(), query: q, k: Number(body?.k) || undefined });
  if (!r.ok) return json(res, 200, { ok: false, reason: r.reason, query: q });
  json(res, 200, {
    ok: true,
    query: r.query,
    matched: r.matched,
    chars: r.chars,
    tookMs: r.tookMs,
    sources: r.sources,
    chunks: r.chunks.map((c) => ({
      file: c.file,
      heading: c.heading,
      startLine: c.startLine,
      endLine: c.endLine,
      score: c.score,
      text: c.text,
    })),
  });
}

/* ---------------- 记忆分层 ---------------- */

/** GET /api/memory —— 五层快照（含自动注入块，界面「查看记忆」用） */
export async function hMemory(req, res) {
  json(res, 200, memoryStats(loadConfig()));
}

/* ---------------- 上下文压缩 ---------------- */

/** POST /api/compress { sessionId } —— 把会话前段压成摘要（同步等模型一次） */
export async function hCompress(req, res, params, body) {
  const id = String(body?.sessionId ?? params?.id ?? '').trim();
  const s = id ? getSession(id) : null;
  if (!s) return json(res, 404, { error: '会话不存在' });
  const cfg = loadConfig();
  const limit = await llamaCtxLimit();
  const before = estimateContext(s, cfg, 3000, limit);
  const r = await compressSession({ session: s, cfg, emit: () => {}, ctxLimit: limit });
  if (!r.ok) return json(res, 200, { ok: false, ...r, estimate: before });
  saveSession(s);
  json(res, 200, {
    ok: true,
    ...r,
    estimate: estimateContext(s, cfg, 3000, limit),
    summaryPreview: String(s.summary || '').slice(0, 600),
  });
}

/* ---------------- llama.cpp 后端 ---------------- */

export async function hLlamaStatus(req, res) {
  json(res, 200, { ...llamaStatus(), up: await llamaProbe(800) });
}

export async function hLlamaStart(req, res) {
  const out = await ensureLlamaServer({ force: true });
  // 200 一律返回：失败原因在 ok:false / reason 里，前端好显示
  json(res, 200, { ...out, status: llamaStatus() });
}

export async function hLlamaStop(req, res) {
  const out = stopLlamaServer();
  json(res, 200, { ...out, status: llamaStatus() });
}

/** POST /api/llamacpp/mode { mode:'external'|'managed' } —— 一键切换端点模式 */
export async function hLlamaMode(req, res, params, body) {
  try {
    const out = await switchLlamaMode(String(body?.mode || '').trim());
    json(res, 200, out);
  } catch (e) {
    json(res, 200, { ok: false, reason: String(e?.message || e), status: llamaStatus() });
  }
}

export async function hTools(req, res) {
  const cfg = loadConfig();
  json(
    res,
    200,
    allTools(cfg).map((t) => ({
      name: t.name,
      risk: t.risk,
      source: t.source || 'builtin',
      hint: t.hint,
      description: t.description,
      parameters: t.parameters,
    }))
  );
}

export async function hGetConfig(req, res) {
  json(res, 200, loadConfig());
}

export async function hPatchConfig(req, res, params, body) {
  try {
    const before = JSON.stringify(loadConfig().mcpServers || {});
    const next = saveConfig(body || {});
    if (JSON.stringify(next.mcpServers || {}) !== before) {
      await syncMcp(next); // MCP 配置变了就地重连
    }
    json(res, 200, next);
  } catch (e) {
    json(res, 400, { error: String(e?.message || e) });
  }
}

/* ---------------- MCP ---------------- */

export async function hMcpStatus(req, res) {
  json(res, 200, { servers: mcpStatus(), tools: allTools(loadConfig()).filter((t) => String(t.name).startsWith('mcp__')).map((t) => t.name) });
}

export async function hMcpRefresh(req, res) {
  try {
    const servers = await syncMcp(loadConfig());
    json(res, 200, { servers, toolCount: allTools(loadConfig()).length });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
}

/* ---------------- 插件 ---------------- */

export async function hPlugins(req, res) {
  json(res, 200, { dir: pluginDir(), plugins: pluginStatus(), tools: allTools(loadConfig()).filter((t) => String(t.name).startsWith('plugin__')).map((t) => t.name) });
}

export async function hPluginsRefresh(req, res) {
  try {
    const plugins = await loadPlugins(loadConfig());
    json(res, 200, { dir: pluginDir(), plugins, toolCount: allTools(loadConfig()).length });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
}

/** 单个插件开关。只改注册表里的 enabled 位（工具表每次现算），不重扫。 */
export async function hPluginToggle(req, res, params, body) {
  const out = setPluginEnabled(body?.name, body?.enabled !== false);
  if (!out.ok) return json(res, 400, out);
  json(res, 200, { ...out, toggles: pluginToggles(), stateFile: pluginToggleFile(), status: pluginStatus() });
}

export async function hPluginsAll(req, res, params, body) {
  const out = setAllPluginsEnabled(body?.enabled !== false);
  json(res, 200, { ...out, toggles: pluginToggles(), stateFile: pluginToggleFile(), status: pluginStatus() });
}

/* ---------------- 技能 ---------------- */

export async function hSkills(req, res) {
  const cfg = loadConfig();
  json(res, 200, {
    ...skillStatus(),
    tools: allTools(cfg)
      .filter((t) => t.source === 'skill')
      .map((t) => t.name),
  });
}

export async function hSkillsRefresh(req, res) {
  try {
    await loadSkills(loadConfig());
    json(res, 200, skillStatus());
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
}

export async function hSkillToggle(req, res, params, body) {
  const out = setSkillEnabled(body?.name, body?.enabled !== false);
  if (!out.ok) return json(res, 400, out);
  json(res, 200, { ...out, stateFile: skillToggleFile(), status: skillStatus() });
}

export async function hSkillsAll(req, res, params, body) {
  const out = setAllSkillsEnabled(body?.enabled !== false);
  json(res, 200, { ...out, stateFile: skillToggleFile(), status: skillStatus() });
}

/* ---------------- 回执（插件 receipt-writer 落盘） ---------------- */

/** GET /api/receipts?name=xxx.md —— 不给 name 就是列表 */
export function hReceipts(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const name = url.searchParams.get('name') || '';
  if (!name) return json(res, 200, { dir: RECEIPT_DIR, items: listReceipts() });
  // 只允许回执目录里的 md/json，禁止路径穿越
  if (!/^[A-Za-z0-9._-]+\.(md|json)$/.test(name)) return json(res, 400, { error: '回执名不合法' });
  try {
    const text = readFileSync(join(RECEIPT_DIR, name), 'utf8');
    json(res, 200, { name, text });
  } catch (e) {
    json(res, 404, { error: `读不到回执：${e?.message || e}` });
  }
}

export async function hListSessions(req, res) {
  json(res, 200, listSessions());
}

export async function hCreateSession(req, res, params, body) {
  const cfg = loadConfig();
  const s = newSession(body?.model || cfg.model);
  saveSession(s);
  json(res, 200, s);
}

export async function hGetSession(req, res, params) {
  const s = getSession(params.id);
  if (!s) return json(res, 404, { error: '会话不存在' });
  json(res, 200, s);
}

export async function hPatchSession(req, res, params, body) {
  const s = getSession(params.id);
  if (!s) return json(res, 404, { error: '会话不存在' });
  if (body?.title) s.title = String(body.title).slice(0, 80);
  if (body?.model) s.model = String(body.model);
  saveSession(s);
  json(res, 200, s);
}

/** 会话是否有正在跑的 run（删除守卫与前端按钮置灰共用同一判据） */
export function sessionHasLiveRun(runs, sessionId) {
  return (Array.isArray(runs) ? runs : []).find((r) => r.sessionId === sessionId && r.status === 'running') || null;
}

export async function hDeleteSession(req, res, params) {
  // 运行中的 run 还攥着 session 对象，跑完会 saveSession 把文件写回来 ⇒ 先拒绝；前端也据此置灰删除按钮。
  const live = sessionHasLiveRun(listRuns(), params.id);
  if (live) return json(res, 409, { error: '这个会话正在运行，先点「停止」再删', runId: live.runId });
  json(res, 200, { ok: deleteSession(params.id) });
}

/**
 * 图片入参白名单：只收 data URL 形式的 png/jpeg/webp，最多 4 张、单张 base64 上限 3.5 MB。
 * 前端已按最长边 1280 / JPEG 0.86 压过（典型 100–250 KB），这里只做兜底校验。
 */
export function normalizeImages(input) {
  const out = [];
  for (const raw of Array.isArray(input) ? input : []) {
    if (out.length >= 4) break;
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) continue;
    if (s.length > 3500000) continue;
    out.push(s);
  }
  return out;
}

export async function hStartRun(req, res, params, body) {
  const text = String(body?.text ?? '').trim();
  const images = normalizeImages(body?.images);
  if (!text && !images.length) return json(res, 400, { error: '消息为空' });
  try {
    const r = startRun({ sessionId: body?.sessionId || null, text, images, overrides: body?.overrides || {} });
    if (r.error) return json(res, 409, r);
    json(res, 200, r);
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
}

export async function hStopRun(req, res, params) {
  json(res, 200, { ok: stopRun(params.id) });
}

export async function hApprove(req, res, params, body) {
  const ok = approveRun(params.id, String(body?.callId || ''), Boolean(body?.allow));
  json(res, 200, { ok });
}

export async function hRunEvents(req, res, params) {
  const evs = runEvents(params.id);
  if (!evs) return json(res, 404, { error: 'run 不存在或已回收' });
  json(res, 200, evs);
}

export function hEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  addClient(res);
}

/* ---------------- 落盘 run 历史 / 续跑 / 人工 steer ---------------- */

export function hRecentRuns(req, res) {
  json(res, 200, recentRuns(20));
}

export function hResumeRun(req, res, params) {
  const out = resumeRun(String(params.id || ''));
  if (out.error) return json(res, 400, out);
  json(res, 200, out);
}

export function hSteerRun(req, res, params, body) {
  const out = steerRun(String(params.id || ''), body?.text);
  if (!out.ok) return json(res, 400, out);
  json(res, 200, out);
}

/* ---------------- 子智能体 ---------------- */

export function hAgents(req, res) {
  const runId = new URL(req.url, 'http://localhost').searchParams.get('runId') || '';
  const list = runAgents(runId);
  if (!list) return json(res, 404, { error: 'run 不存在或已回收' });
  json(res, 200, list);
}

export function hMessageAgent(req, res, params, body) {
  const runId = new URL(req.url, 'http://localhost').searchParams.get('runId') || '';
  const out = messageAgent(runId, String(params.id || ''), body?.text);
  if (!out.ok) return json(res, 400, out);
  json(res, 200, out);
}
