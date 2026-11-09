/**
 * MCP 三种传输的端到端验证。
 *
 *   node test/mcp-live.mjs
 *
 * - http（Streamable HTTP）/ sse（旧版 HTTP+SSE）：本进程内起一台假服务器，不需要 spawn，
 *   受限沙箱里也能跑通。
 * - stdio：真起一个子进程；受限沙箱禁止管道 stdio 时打印跳过，不算失败。
 *
 * 覆盖：握手 → tools/list → tools/call、会话头回传、headers 里 ${ENV} 展开、
 * SSE 响应解析（tools/list 与 tools/call 都故意走 SSE）、legacy endpoint 发现、
 * 混合配置、配置变更即时重连、closeMcp 清空、配置校验报错。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.BW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-mcp-'));
process.env.OW_TEST_TOKEN = 'sekrit-42'; // 验证 headers 里的 ${ENV} 展开

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { syncMcp, mcpStatus, mcpToolDefs, callMcpTool, closeMcp, parseToolName, toolNameFor } = await import('../model/mcp.mjs');
const { startFakeHttpMcp } = await import('./fake-mcp-http-server.mjs');

let pass = 0;
let fail = 0;
let skip = 0;

async function t(name, fn) {
  try {
    const r = await fn();
    if (r === 'skip') {
      skip++;
      console.log(`  [skip] ${name}`);
    } else {
      pass++;
      console.log(`  [ok] ${name}`);
    }
  } catch (e) {
    fail++;
    console.log(`  [FAIL] ${name}\n         ${e?.message || e}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

const fake = await startFakeHttpMcp();
console.log(`\n[fake] ${fake.url}（同一端口：/mcp 走 Streamable HTTP，/sse 走旧版 HTTP+SSE）`);

/* ================= 1. Streamable HTTP ================= */
console.log('\n[mcp] Streamable HTTP（POST /mcp，结果可能在 SSE 流里）');
const httpCfg = {
  mcpServers: {
    httpDemo: { type: 'http', url: `${fake.url}/mcp`, headers: { 'x-ow-token': '${OW_TEST_TOKEN}' } },
  },
};
const httpStatus = await syncMcp(httpCfg);

await t('http 服务器连上（status=ready）', () => {
  assert.equal(httpStatus.length, 1);
  assert.equal(httpStatus[0].status, 'ready', httpStatus[0].error || '');
});
await t('状态里带传输类型 transport=http', () => {
  assert.equal(mcpStatus()[0].transport, 'http');
});
await t('tools/list 从 SSE 流里取到 echo/add', () => {
  assert.deepEqual([...mcpStatus()[0].tools].sort(), ['add', 'echo']);
});
await t('后续请求回传了 Mcp-Session-Id（没回传会被假服务器 400）', () => {
  assert.ok(fake.state.sawSessionId > 0, `sawSessionId=${fake.state.sawSessionId}`);
});
await t('headers 里的 ${ENV} 从环境变量展开', () => {
  assert.ok(
    fake.state.headersSeen.some((h) => h['x-ow-token'] === 'sekrit-42'),
    '假服务器没看到展开后的 x-ow-token'
  );
});
await t('工具名映射成 mcp__server__tool 并可反解', () => {
  const names = mcpToolDefs().map((d) => d.name).sort();
  assert.deepEqual(names, ['mcp__httpDemo__add', 'mcp__httpDemo__echo']);
  assert.deepEqual(parseToolName('mcp__httpDemo__echo'), { server: 'httpDemo', tool: 'echo' });
  assert.equal(toolNameFor('httpDemo', 'echo'), 'mcp__httpDemo__echo');
  assert.equal(parseToolName('mcp__only'), null);
});
await t('真调 echo：原文回显', async () => {
  const r = await callMcpTool('mcp__httpDemo__echo', { text: '你好 MCP' });
  assert.equal(r.ok, true, r.output);
  assert.equal(r.output, '你好 MCP');
});
await t('真调 add：2+40=42（SSE 响应路径）', async () => {
  const r = await callMcpTool('mcp__httpDemo__add', { a: 2, b: 40 });
  assert.equal(r.ok, true, r.output);
  assert.equal(r.output, '42');
});
await t('未知工具返回 ok:false', async () => {
  const r = await callMcpTool('mcp__httpDemo__nope', {});
  assert.equal(r.ok, false);
});
await t('无此服务器返回 ok:false', async () => {
  const r = await callMcpTool('mcp__ghost__x', {});
  assert.equal(r.ok, false);
});

/* ================= 2. 旧版 HTTP+SSE ================= */
console.log('\n[mcp] 旧版 HTTP+SSE（GET /sse 收消息，event:endpoint 给 POST 地址）');
const sseCfg = { mcpServers: { sseDemo: { type: 'sse', url: `${fake.url}/sse` } } };
const sseStatus = await syncMcp(sseCfg);

await t('sse 服务器连上（status=ready）', () => {
  assert.equal(sseStatus.length, 1);
  assert.equal(sseStatus[0].status, 'ready', sseStatus[0].error || '');
});
await t('状态里带 transport=sse，且旧 http 连接已被断开', () => {
  assert.equal(mcpStatus().length, 1);
  assert.equal(mcpStatus()[0].name, 'sseDemo');
  assert.equal(mcpStatus()[0].transport, 'sse');
});
await t('关闭旧会话时发了 DELETE /mcp', async () => {
  const ok = await waitFor(() => fake.state.deleted > 0);
  assert.ok(ok, `deleted=${fake.state.deleted}`);
});
await t('sse 上真调 echo', async () => {
  const r = await callMcpTool('mcp__sseDemo__echo', { text: '从 SSE 流回来' });
  assert.equal(r.ok, true, r.output);
  assert.equal(r.output, '从 SSE 流回来');
});
await t('sse 上真调 add', async () => {
  const r = await callMcpTool('mcp__sseDemo__add', { a: 1, b: 2 });
  assert.equal(r.ok, true, r.output);
  assert.equal(r.output, '3');
});

/* ================= 3. 混合配置 ================= */
console.log('\n[mcp] 混合配置（stdio + http + sse 同时在线）');
const mixed = await syncMcp({
  mcpServers: {
    demo: { command: process.execPath, args: [path.join(HERE, 'fake-mcp-server.mjs')] },
    httpDemo: { type: 'http', url: `${fake.url}/mcp` },
    sseDemo: { type: 'sse', url: `${fake.url}/sse` },
  },
});
const stdioRec = mixed.find((r) => r.name === 'demo');
const stdioBlocked = stdioRec.status === 'error' && /EPERM|EACCES|被拒绝|管道 stdio/.test(stdioRec.error || '');

await t('http / sse 两路在混合配置下都 ready', () => {
  assert.equal(mixed.find((r) => r.name === 'httpDemo').status, 'ready');
  assert.equal(mixed.find((r) => r.name === 'sseDemo').status, 'ready');
});
await t('stdio 服务器：连上则真调 echo，被沙箱拦则跳过', async () => {
  if (stdioBlocked) {
    console.log('         （受限沙箱禁止管道 stdio，stdio 部分跳过）');
    return 'skip';
  }
  assert.equal(stdioRec.status, 'ready', stdioRec.error || '');
  const r = await callMcpTool('mcp__demo__echo', { text: '你好 MCP' });
  assert.equal(r.ok, true, r.output);
  assert.equal(r.output, '你好 MCP');
  const add = await callMcpTool('mcp__demo__add', { a: 2, b: 40 });
  assert.equal(add.output, '42');
});
await t('三路工具都在工具表里', () => {
  const names = mcpToolDefs().map((d) => d.name);
  assert.ok(names.includes('mcp__httpDemo__echo'));
  assert.ok(names.includes('mcp__sseDemo__echo'));
  if (!stdioBlocked) assert.ok(names.includes('mcp__demo__echo'));
});

/* ================= 4. 配置校验 ================= */
console.log('\n[mcp] 配置校验与清理');
await t('未知传输类型报人话错误', async () => {
  const st = await syncMcp({ mcpServers: { bad: { type: 'carrier-pigeon', url: 'http://x/y' } } });
  assert.equal(st[0].status, 'error');
  assert.match(st[0].error, /未知的 MCP 传输类型/);
});
await t('url 不是 http(s) 时报错（不发网络请求）', async () => {
  const st = await syncMcp({ mcpServers: { bad: { type: 'http', url: 'ftp://example.com/mcp' } } });
  assert.equal(st[0].status, 'error');
  assert.match(st[0].error, /必须是 http:\/\/ 或 https:\/\//);
});
await t('缺 command / url 的配置报错', async () => {
  const st = await syncMcp({ mcpServers: { bad: {} } });
  assert.equal(st[0].status, 'error');
  assert.match(st[0].error, /缺少 command.*url|缺少 command/);
});
await t('closeMcp() 清空注册表与工具表', () => {
  closeMcp();
  assert.equal(mcpStatus().length, 0);
  assert.equal(mcpToolDefs().length, 0);
});

fake.close();
console.log(`\n${fail === 0 ? 'MCP_LIVE PASS' : 'MCP_LIVE FAIL'}  ${pass} passed, ${skip} skipped, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
