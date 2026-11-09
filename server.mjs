#!/usr/bin/env node
/**
 * Bonsai Workbench — 入口（MVC 装配）
 *
 * 独立的一条线：只连 llama.cpp / LLMpod 的 OpenAI 兼容 /v1，不碰 Ollama。
 *
 *   model/       数据与业务规则（config / store / llm 客户端 / tools / permission / parser / agent）
 *   controller/  HTTP 路由与动作编排（router / api / runs / events / static）
 *   view/        呈现层（HTML + CSS + 浏览器渲染脚本）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRouter, json } from './controller/router.mjs';
import { serveStatic } from './controller/static.mjs';
import { loadConfig, DATA_DIR } from './model/config.mjs';
import { syncMcp, closeMcp } from './model/mcp.mjs';
import { loadPlugins } from './model/plugins.mjs';
import { loadSkills } from './model/skills.mjs';
import { buildIndex as buildRagIndex, ragStatus } from './model/rag.mjs';
import { ensureServer as ensureLlama, stopServer as stopLlama } from './model/llm.mjs';
import { initRuns } from './controller/runs.mjs';
import {
  hState, hModels, hRefreshModels, hTools, hGetConfig, hPatchConfig,
  hListSessions, hCreateSession, hGetSession, hPatchSession, hDeleteSession,
  hStartRun, hStopRun, hApprove, hRunEvents, hEvents,
  hMcpStatus, hMcpRefresh, hRecentRuns, hResumeRun, hSteerRun, hAgents, hMessageAgent,
  hPlugins, hPluginsRefresh, hPluginToggle, hPluginsAll,
  hSkills, hSkillsRefresh, hSkillToggle, hSkillsAll,
  hLlamaStatus, hLlamaStart, hLlamaStop, hLlamaMode, hReceipts,
  hRagStatus, hRagIndex, hRagSearch, hCompress, hMemory,
} from './controller/api.mjs';
import { pruneDaily, memoryStatus } from './model/memory.mjs';

const router = createRouter();
router.get('/api/health', (req, res) => json(res, 200, { ok: true, app: 'bonsai-workbench' }));
router.get('/api/state', hState);
router.get('/api/models', hModels);
router.post('/api/models/refresh', hRefreshModels);
router.get('/api/tools', hTools);
router.get('/api/config', hGetConfig);
router.patch('/api/config', hPatchConfig);
router.get('/api/sessions', hListSessions);
router.post('/api/sessions', hCreateSession);
router.get('/api/sessions/:id', hGetSession);
router.patch('/api/sessions/:id', hPatchSession);
router.delete('/api/sessions/:id', hDeleteSession);
router.post('/api/runs', hStartRun);
router.get('/api/runs/recent', hRecentRuns);
router.post('/api/runs/:id/stop', hStopRun);
router.post('/api/runs/:id/approve', hApprove);
router.post('/api/runs/:id/resume', hResumeRun);
router.post('/api/runs/:id/steer', hSteerRun);
router.get('/api/runs/:id/events', hRunEvents);
router.get('/api/agents', hAgents);
router.post('/api/agents/:id/message', hMessageAgent);
router.get('/api/mcp', hMcpStatus);
router.post('/api/mcp/refresh', hMcpRefresh);
router.get('/api/plugins', hPlugins);
router.post('/api/plugins/refresh', hPluginsRefresh);
router.post('/api/plugins/toggle', hPluginToggle);
router.post('/api/plugins/all', hPluginsAll);
router.get('/api/skills', hSkills);
router.post('/api/skills/refresh', hSkillsRefresh);
router.post('/api/skills/toggle', hSkillToggle);
router.post('/api/skills/all', hSkillsAll);
router.get('/api/rag', hRagStatus);
router.post('/api/rag/index', hRagIndex);
router.post('/api/rag/search', hRagSearch);
router.post('/api/compress', hCompress);
router.get('/api/memory', hMemory);
router.get('/api/receipts', hReceipts);
router.get('/api/llamacpp/status', hLlamaStatus);
router.post('/api/llamacpp/start', hLlamaStart);
router.post('/api/llamacpp/stop', hLlamaStop);
router.post('/api/llamacpp/mode', hLlamaMode);
router.get('/api/events', hEvents);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const match = router.match(req.method, pathname);
  if (!match) return json(res, 404, { error: `没有这个接口：${req.method} ${pathname}` });

  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e) });
    }
  }

  try {
    await match.handler(req, res, match.params, body);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e?.message || e) });
    else res.end();
  }
});

const cfg = loadConfig();
const PORT = Number(process.env.BW_PORT) || 4790;
const HOST = process.env.BW_HOST || '127.0.0.1';

// 启动前：把上次没跑完的 run 标成 interrupted（可续跑），再连 MCP、加载插件
const { interrupted } = initRuns();
const mcpServers = await syncMcp(cfg).catch((e) => {
  console.error('  MCP 初始化失败：', e?.message || e);
  return [];
});
const plugins = await loadPlugins(cfg).catch((e) => {
  console.error('  插件加载失败：', e?.message || e);
  return [];
});
let skills;
try {
  skills = loadSkills(cfg);
} catch (e) {
  console.error('  技能加载失败：', e?.message || e);
  skills = { skills: [] };
}

// 记忆分层：启动时清掉过期每日日志，并报一眼当前注入成本
pruneDaily(30);
const mem = memoryStatus(cfg);

// 知识库索引「开箱即用」：缺索引、或工作区/目录变了就自动建一次（实测 1.4 s / 272 文件；
// 增量口径按 size+mtime 复用旧块，之后启动几乎不花时间）。不再要求先去设置面板手点重建。
try {
  const st = ragStatus(cfg);
  if (st.enabled && (!st.exists || st.rootChanged)) {
    const meta = buildRagIndex({ cfg });
    console.log(
      `  RAG    索引已建：${meta.files} 文件 / ${meta.chunks} 块${meta.truncated ? '（超过块数上限，已截断）' : ''}，${meta.ms} ms`,
    );
  }
} catch (e) {
  console.error('  RAG    索引建立失败：', e?.message || e);
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  Bonsai Workbench');
  console.log('  ────────────────────────────────────────');
  console.log(`  界面   ${url}`);
  console.log(`  工作区 ${cfg.workspace}`);
  console.log(`  数据   ${DATA_DIR}`);
  console.log(`  端点   ${cfg.llamacpp?.host || '(未配置)'}${cfg.llamacpp?.autostart ? '（本机托管，自动启动）' : '（外部端点）'}`);
  console.log(`  模型   ${cfg.model || '(等端点就绪后自动选)'}`);
  console.log(`  权限   ${cfg.permission} / ${cfg.approval}`);
  console.log(
    `  MCP    ${
      mcpServers.length
        ? mcpServers.map((s) => `${s.name}[${s.transport || 'stdio'}]=${s.status}(${s.toolCount || 0})`).join('  ')
        : '未配置'
    }`
  );
  console.log(`  插件   ${plugins.length ? plugins.map((p) => `${p.name}${p.error ? '!' : ''}(${p.tools.length})`).join('  ') : '无（往插件目录丢一个即可）'}`);  const skillOn = (skills.skills || []).filter((s) => s.enabled && !s.error).length;
  console.log(`  技能   ${skillOn} 个启用${cfg.skillsEnabled === false ? '（已关闭）' : ''}（${(skills.dirs || []).join('  ') || '未找到技能目录'}）`);
  console.log(
    `  记忆   ${mem.layers.map((l) => `${l.label} ${l.count}`).join(' / ')}${
      mem.injectChars ? `（自动注入 ${mem.injectChars} 字符）` : '（全空，不占上下文）'
    }`,
  );
  if (interrupted.length) console.log(`  续跑   ${interrupted.length} 个 run 被中断：${interrupted.join(', ')}`);
  console.log('');
  console.log('  Ctrl+C 退出');
  console.log('');

  // 自动拉起 llama.cpp 端点：不阻塞端口（27B 加载要十几秒），失败只打印
  if (cfg.llamacpp?.autostart && !process.env.BW_NO_LLAMA) {
    ensureLlama()
      .then((r) => {
        if (r.ok) console.log(`  端点   ${r.pid ? `已启动（pid ${r.pid}）` : '已就绪（复用已在跑的端点）'}\n`);
        else console.log(`  端点   未就绪：${r.reason}\n`);
      })
      .catch((e) => console.log(`  端点   启动失败：${e?.message || e}\n`));
  }

  // BW_OPEN=1 时自动打开浏览器（双击 .bat 启动用）
  if (process.env.BW_OPEN) {
    try {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    } catch {
      /* 打不开就算了，手动点链接 */
    }
  }
});

// 退干净：MCP 子进程与 llama-server 都不能留成孤儿
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      await closeMcp();
    } catch {
      /* ignore */
    }
    stopLlama();
    process.exit(0);
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用。换一个：set BW_PORT=4791 && node server.mjs`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
