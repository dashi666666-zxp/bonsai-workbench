#!/usr/bin/env node
/**
 * Bonsai 工作台 —— 离线冒烟测试（不连 llama.cpp、不联网）
 *
 * 覆盖：配置默认值与落盘、权限档、parser 两层工具解析、token saver、
 *       会话存储、llm 纯函数、插件钩子契约、receipt-writer 回执、
 *       /api/receipts 的列表函数、以及“这条线不碰 Ollama”的静态断言。
 *
 * 运行：node test/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 先隔离数据目录，再 import 任何会读 env 的模块
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-smoke-'));
const RECEIPTS = path.join(TMP, 'receipts');
process.env.BW_DATA = TMP;
process.env.BW_RECEIPT_DIR = RECEIPTS;
process.env.BW_CONFIG = path.join(TMP, 'config.json');
process.env.BW_PLUGINS = path.join(TMP, 'plugins');
process.env.BW_PLUGIN_STATE = path.join(TMP, 'plugin-toggles.json');
process.env.BW_SKILL_STATE = path.join(TMP, 'skill-toggles.json');

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    return true;
  }
  failures.push(detail ? `${name} — ${detail}` : name);
  return false;
}
function eq(name, actual, expected) {
  return ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}

const config = await import('../model/config.mjs');
const store = await import('../model/store.mjs');
const permission = await import('../model/permission.mjs');
const parser = await import('../model/parser.mjs');
const agent = await import('../model/agent.mjs');
const llm = await import('../model/llm.mjs');
const plugins = await import('../model/plugins.mjs');
const tools = await import('../model/tools.mjs');
const rag = await import('../model/rag.mjs');
const ragChunk = await import('../model/rag/chunk.mjs');
const ragTokens = await import('../model/rag/tokens.mjs');
const ragGround = await import('../model/rag/ground.mjs');
const compress = await import('../model/compress.mjs');

/* ---------------- 配置 ---------------- */
eq('config.DATA_DIR 指向 BW_DATA', config.DATA_DIR, TMP);
eq('config.RECEIPT_DIR 指向 BW_RECEIPT_DIR', config.RECEIPT_DIR, RECEIPTS);
eq('config.configFile 指向 BW_CONFIG', config.configFile(), process.env.BW_CONFIG);

const cfg = config.loadConfig();
ok('默认 extraArgs 带 -np 1（单槽排队）', cfg.llamacpp.extraArgs.includes('-np 1'), cfg.llamacpp.extraArgs);
ok('默认端口 8082', cfg.llamacpp.host === 'http://127.0.0.1:8082');
ok('默认权限档 workspace-write', cfg.permission === 'workspace-write');
ok('默认 think 关闭', cfg.think === false);
ok('默认带 workspace（空则回退 cwd）', typeof cfg.workspace === 'string' && cfg.workspace.length > 0);
ok('默认配置里没有 ollama 段', !Object.prototype.hasOwnProperty.call(config.DEFAULTS, 'ollama'));
ok('data 目录在初始化时建好', fs.existsSync(TMP) && fs.existsSync(RECEIPTS));

config.saveConfig({ model: 'llama/bonsai-2-27b', llamacpp: { host: 'http://127.0.0.1:9999' } });
const saved = JSON.parse(fs.readFileSync(process.env.BW_CONFIG, 'utf8'));
eq('saveConfig 落盘 model', saved.model, 'llama/bonsai-2-27b');
eq('saveConfig 深合并 llamacpp.host', saved.llamacpp.host, 'http://127.0.0.1:9999');
ok('saveConfig 保留未改的默认值', saved.llamacpp.extraArgs.includes('-np 1'));
config.saveConfig({ llamacpp: { host: 'http://127.0.0.1:8082' } });

/* ---------------- 权限 ---------------- */
eq('riskOf(read_file)', permission.riskOf('read_file'), 'read');
eq('riskOf(write_file)', permission.riskOf('write_file'), 'write');
eq('riskOf(mcp__x__y) 强制 exec', permission.riskOf('mcp__x__y'), 'exec');
eq('riskOf(plugin__x__y) 强制 exec', permission.riskOf('plugin__x__y'), 'exec');

const readOnly = { permission: 'read-only', workspace: TMP, approval: 'auto' };
ok('只读档允许 read_file', permission.checkPermission('read_file', { path: 'a.txt' }, readOnly).allow);
const roWrite = permission.checkPermission('write_file', { path: path.join(TMP, 'a.txt') }, readOnly);
ok('只读档拒绝 write_file', !roWrite.allow && /只读/.test(roWrite.reason), roWrite.reason);

const wsWrite = { permission: 'workspace-write', workspace: TMP, approval: 'auto' };
ok('workspace-write 允许区内写', permission.checkPermission('write_file', { path: 'sub/a.txt' }, wsWrite).allow);
const outside = permission.checkPermission('write_file', { path: 'C:\\Windows\\x.txt' }, wsWrite);
ok('workspace-write 拒绝越界写', !outside.allow && /越界/.test(outside.reason), outside.reason);

/* ---------------- parser ---------------- */
const native = parser.normalizeNativeCalls([
  { id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
  { function: { name: 'list_dir', arguments: { path: '.' } } },
]);
eq('normalizeNativeCalls 数量', native.length, 2);
eq('normalizeNativeCalls 名字', native[0].name, 'read_file');
eq('normalizeNativeCalls 参数', native[0].args, { path: 'a.txt' });
eq('normalizeNativeCalls 扁平参数', native[1].args, { path: '.' });

const fromText = parser.extractToolCalls(
  '我来读一下：\n```json\n{"name":"read_file","arguments":{"path":"README.md"}}\n```',
  ['read_file', 'list_dir']
);
eq('extractToolCalls 命中 1 条', fromText.calls.length, 1);
eq('extractToolCalls 名字', fromText.calls[0].name, 'read_file');
eq('extractToolCalls 参数', fromText.calls[0].args, { path: 'README.md' });
ok('extractToolCalls 全部匹配', fromText.matched === true);

/* ---------------- token saver / 系统提示 ---------------- */
const saverCfg = { tokenSaver: { toolOutputMaxChars: 120, toolOutputMaxLines: 5 } };
const big = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
const keep = agent.applyTokenSaver('短输出', saverCfg);
eq('applyTokenSaver 短文本原样', keep.text, '短输出');
eq('applyTokenSaver 短文本未截断', keep.truncated, false);
const short = agent.applyTokenSaver(big, saverCfg);
ok(
  'applyTokenSaver 大文本被截断',
  short.truncated === true && short.text.length < big.length && /省略/.test(short.text),
  `${big.length} → ${short.text.length}`
);

const prompt = agent.buildSystemPrompt(cfg, []);
ok('系统提示声明 llama.cpp 端点', prompt.includes('llama.cpp'));
ok('系统提示不再注入 memory recall', !prompt.includes('recall'));
ok('系统提示带工作区', prompt.includes(cfg.workspace));

/* ---------------- 会话存储 ---------------- */
const s1 = store.newSession('llama/bonsai-2-27b');
ok('newSession 产物带 id', /^s_/.test(s1.id), s1.id);
store.saveSession(s1);
s1.messages.push({ role: 'user', content: '你好，帮我看看 README' });
store.saveSession(s1);
const got = store.getSession(s1.id);
ok('saveSession/getSession 往返', got && got.messages.length === 1);
ok('首条用户消息生成标题', got.title && got.title.includes('你好'), got.title);
const listed = store.listSessions();
ok('listSessions 含新会话', listed.some((x) => x.id === s1.id));
store.deleteSession(s1.id);
ok('deleteSession 生效', !store.getSession(s1.id));

/* ---------------- llm 纯函数（不连服务） ---------------- */
eq('displayName 去 llama/ 前缀', llm.displayName('llama/bonsai-2-27b'), 'bonsai-2-27b');
const caps = await llm.modelCaps('llama/bonsai-2-27b');
ok('modelCaps 离线兜底含 completion', Array.isArray(caps.caps) && caps.caps.includes('completion'), JSON.stringify(caps));
ok('modelCaps 离线返回数字 contextLength', typeof caps.contextLength === 'number');

/* ---------------- 插件：钩子型插件契约 ---------------- */
const plugRoot = process.env.BW_PLUGINS;
const receiptSrc = path.join(ROOT, 'examples', 'plugins', 'receipt-writer');
const receiptDst = path.join(plugRoot, 'receipt-writer');
fs.mkdirSync(receiptDst, { recursive: true });
for (const f of ['plugin.json', 'index.mjs']) fs.copyFileSync(path.join(receiptSrc, f), path.join(receiptDst, f));

const badDir = path.join(plugRoot, 'bad-hook');
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, 'plugin.json'), JSON.stringify({ name: 'bad-hook', version: '0.1.0', description: '冒烟用坏插件' }), 'utf8');
fs.writeFileSync(
  path.join(badDir, 'index.mjs'),
  "export const hooks = { async runEnd() { throw new Error('boom'); } };\n",
  'utf8'
);

const status = await plugins.loadPlugins(config.loadConfig());
const rw = status.find((p) => p.name === 'receipt-writer');
const bad = status.find((p) => p.name === 'bad-hook');
ok('只带 hooks 的插件也能加载', Boolean(bad && !bad.error), bad?.error);
eq('receipt-writer 钩子表', rw?.hooks, ['runEnd']);
ok('receipt-writer 工具已注册', rw?.tools.some((t) => t.fullName === 'plugin__receipt-writer__write_receipt'));
ok('坏插件钩子被隔离', (await plugins.runPluginHooks('runEnd', {})).some((r) => r.plugin === 'bad-hook' && r.ok === false));
ok('hookErrors 记录了坏钩子', (plugins.pluginStatus().find((p) => p.name === 'bad-hook')?.hookErrors || []).length >= 1);

/* ---------------- receipt-writer：runEnd 落盘 ---------------- */
const runId = 'r_smoke0001';
const ctx = {
  runId,
  sessionId: 's_smoke',
  task: '冒烟测试：读 README 并总结',
  status: 'done',
  error: null,
  startedAt: Date.now() - 1500,
  endedAt: Date.now(),
  model: 'llama/bonsai-2-27b',
  permission: 'workspace-write',
  think: false,
  resumed: false,
  events: [
    { type: 'run_start', at: Date.now() - 1500 },
    { type: 'step', n: 1, at: Date.now() - 1400 },
    { type: 'delta', kind: 'content', text: '好的，我看一下。' },
    { type: 'tool_start', callId: 'c1', name: 'read_file', args: { path: 'README.md' } },
    { type: 'tool_end', callId: 'c1', name: 'read_file', ok: true, ms: 3, output: '# Bonsai Workbench' },
    { type: 'usage', promptEval: 1200, evalCount: 40, evalMs: 900, totalMs: 1400, tps: 44 },
    { type: 'run_end', status: 'done' },
  ],
  session: { id: 's_smoke', messages: [] },
  cfg,
  dataDir: TMP,
};
const hookResults = await plugins.runPluginHooks('runEnd', ctx);
const rwRes = hookResults.find((r) => r.plugin === 'receipt-writer');
ok('receipt-writer runEnd 钩子成功', Boolean(rwRes && rwRes.ok), rwRes?.error);

const mdFile = path.join(RECEIPTS, `${runId}.md`);
const jsonFile = path.join(RECEIPTS, `${runId}.json`);
ok('回执 md 落盘', fs.existsSync(mdFile));
ok('回执 json 落盘', fs.existsSync(jsonFile));
if (fs.existsSync(mdFile)) {
  const md = fs.readFileSync(mdFile, 'utf8');
  ok('回执 md 含运行 ID', md.includes(runId));
  ok('回执 md 含工具调用表', md.includes('read_file'));
  ok('回执 md 含耗时列', md.includes('用时'));
}
if (fs.existsSync(jsonFile)) {
  const json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  eq('回执 json status', json.status, 'done');
  eq('回执 json 工具调用数', json.toolCalls.length, 1);
  eq('回执 json 模型名', json.model, 'llama/bonsai-2-27b');
}

/* ---------------- 插件停用后不再触发 ---------------- */
plugins.setPluginEnabled('bad-hook', false);
const afterDisable = await plugins.runPluginHooks('runEnd', {});
ok('停用插件不触发钩子', !afterDisable.some((r) => r.plugin === 'bad-hook'));
plugins.setPluginEnabled('bad-hook', true);

/* ---------------- /api/receipts 的列表函数 ---------------- */
const api = await import('../controller/api.mjs');
const receipts = api.listReceipts();
ok('listReceipts 找到 md+json', receipts.length >= 2, JSON.stringify(receipts.map((r) => r.name)));
ok('listReceipts 按 mtime 倒序', receipts.length < 2 || receipts[0].mtime >= receipts[1].mtime);

/* ---------------- 会话删除：运行中守卫 + handler 回执 ---------------- */
const fakeRes = () => ({
  code: 0,
  body: '',
  writeHead(c) {
    this.code = c;
  },
  end(b) {
    this.body = b;
  },
});
const s2 = store.newSession('llama/bonsai-2-27b');
store.saveSession(s2);
const delOk = fakeRes();
await api.hDeleteSession({}, delOk, { id: s2.id });
ok('DELETE 会话返回 200 且 ok', delOk.code === 200 && JSON.parse(delOk.body).ok === true, delOk.body);
ok('删除后会话已不存在', !store.getSession(s2.id));
const delMiss = fakeRes();
await api.hDeleteSession({}, delMiss, { id: 's_00000000' });
eq('删除不存在的会话回 ok:false', JSON.parse(delMiss.body).ok, false);
ok(
  '运行中的会话判忙',
  api.sessionHasLiveRun([{ sessionId: 's_live01', status: 'running' }], 's_live01')?.sessionId === 's_live01',
);
ok('已结束的 run 不判忙', api.sessionHasLiveRun([{ sessionId: 's_live01', status: 'done' }], 's_live01') === null);
ok('只有同会话的 run 才判忙', api.sessionHasLiveRun([{ sessionId: 's_other1', status: 'running' }], 's_live01') === null);

/* ---------------- 多模态（图片 → OpenAI content 数组） ---------------- */
const llamacpp = await import('../model/llamacpp.mjs');
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
ok('isImageDataUrl 认 png data URL', llamacpp.isImageDataUrl(IMG));
ok('isImageDataUrl 拒绝普通文本', !llamacpp.isImageDataUrl('hello'));
ok('isImageDataUrl 拒绝 http 图床地址', !llamacpp.isImageDataUrl('https://example.com/a.png'));
eq('一张图按 1100 token 估', llamacpp.IMAGE_TOKENS, 1100);

const openai = llamacpp.toOpenAIMessages([
  { role: 'system', content: 'sys' },
  { role: 'user', content: '这张图是什么', images: [IMG] },
  { role: 'assistant', content: '是界面截图' },
  { role: 'user', content: '再说一遍' },
]);
eq('带图 user 变 content 数组', Array.isArray(openai[1].content), true);
eq('content 数组首段是文本', openai[1].content[0], { type: 'text', text: '这张图是什么' });
eq('content 数组次段是 image_url', openai[1].content[1].type, 'image_url');
eq('image_url 用 data URL 原样传', openai[1].content[1].image_url.url, IMG);
eq('无图 user 仍是字符串', typeof openai[3].content, 'string');
eq('图片段数 = 1 文本 + 1 图', openai[1].content.length, 2);

const onlyImg = llamacpp.toOpenAIMessages([{ role: 'user', content: '', images: [IMG] }]);
eq('纯图消息补占位文本', onlyImg[0].content[0].text, '（见图片）');

// 上下文装不下时先丢图、留文本：$IMG 占 ~1100 token，ctx=1200 的预算装不下
const [fitted, trimmed] = llamacpp.fitMessages(
  [{ role: 'system', content: 's' }, { role: 'user', content: 'hi', images: [IMG] }],
  1200,
  '',
  1,
);
ok('fitMessages 报裁剪', trimmed === true);
eq('裁掉图后 content 退回纯文本', typeof fitted[1].content, 'string');
eq('裁掉图后文本保留', fitted[1].content, 'hi');

const args = llamacpp.mmprojArgs({ mmproj: 'D:\\m\\mm.gguf' });
eq('mmproj 参数顺序', args, ['--mmproj', 'D:\\m\\mm.gguf', '--no-mmproj-offload']);
eq('没配 mmproj 就不加参数', llamacpp.mmprojArgs({}), []);
eq('没配 mmproj 就不加参数（空串）', llamacpp.mmprojArgs({ mmproj: '  ' }), []);

// 端点模式一键切换（v0.7.0）：显式 mode 优先，老配置按「自启 + 两条路径」推断
eq('模式推断：外部端点（不自启、无托管路径）', llamacpp.modeOf({ autostart: false, serverPath: '', modelPath: '' }), 'external');
eq('模式推断：托管（自启 + serverPath + modelPath）', llamacpp.modeOf({ autostart: true, serverPath: 'a', modelPath: 'b' }), 'managed');
eq('显式 mode=external 优先于推断', llamacpp.modeOf({ mode: 'external', autostart: true, serverPath: 'a', modelPath: 'b' }), 'external');
ok('未知模式被拒（不写配置）', (await llamacpp.switchMode('bogus')).ok === false);
ok('默认配置有两套模式预设', Boolean(config.DEFAULTS.llamacpp.profiles.external && config.DEFAULTS.llamacpp.profiles.managed));
ok('托管预设带 mmproj（视觉塔）', /\.gguf$/.test(config.DEFAULTS.llamacpp.profiles.managed.mmproj || ''), config.DEFAULTS.llamacpp.profiles.managed.mmproj);
ok('外部端点预设带 key 文件（ada 服务要 Bearer）', /api_key\.txt$/i.test(config.DEFAULTS.llamacpp.profiles.external.apiKeyFile || ''), config.DEFAULTS.llamacpp.profiles.external.apiKeyFile);

/* ---------------- 鉴权（外部端点要 Bearer） ---------------- */
{
  const keyFile = path.join(TMP, 'api_key.txt');
  fs.writeFileSync(keyFile, '  smoke-key-123\n');
  config.saveConfig({ llamacpp: { apiKey: '', apiKeyFile: keyFile } });
  eq('apiKeyFile 读取并去空白', llamacpp.apiKey(), 'smoke-key-123');
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(keyFile, 'second-key');
  fs.utimesSync(keyFile, later, later);
  eq('key 文件变更后重读（不缓存旧值）', llamacpp.apiKey(), 'second-key');
  config.saveConfig({ llamacpp: { apiKey: 'inline-key' } });
  eq('内联 apiKey 优先于文件', llamacpp.apiKey(), 'inline-key');
  config.saveConfig({ llamacpp: { apiKey: '', apiKeyFile: '' } });
  eq('两处都没配时返回空串（不带 Authorization）', llamacpp.apiKey(), '');
  config.saveConfig({ llamacpp: { apiKey: '', apiKeyFile: path.join(TMP, 'missing_key.txt') } });
  eq('key 文件不存在时返回空串', llamacpp.apiKey(), '');
  config.saveConfig({ llamacpp: { apiKey: '', apiKeyFile: '' } });
}

// 服务端入参白名单
const normalized = api.normalizeImages([IMG, 'not-a-url', 'data:text/plain;base64,AAA', IMG, IMG, IMG, IMG]);
eq('normalizeImages 只留合法 data URL', normalized.length, 4);
eq('normalizeImages 丢非法串', normalized.every((s) => s.startsWith('data:image/png;base64,')), true);
eq('normalizeImages 空入参', api.normalizeImages(undefined), []);

/* ---------------- RAG：切块 / 词法 / 检索 / 引用校验 ---------------- */
const md = [
  '# 顶层标题',
  '',
  '第一段：讲 llama.cpp 的 -np 1 与显存。',
  '',
  '## 二级标题',
  '',
  '第二段：Bonsai 三值量化需要 PrismML 运行时。',
  '',
  '### 三级',
  '',
  '第三段：RAG 切片按标题路径组织，行号必须准确。',
].join('\n');
const secs = ragChunk.splitSections(md);
eq('splitSections 分出 3 节', secs.length, 3);
const chunks = ragChunk.chunkText(md, { size: 120, overlap: 20, minSize: 20 });
ok('chunkText 产出多块', chunks.length >= 2, String(chunks.length));
ok('chunkText 带标题路径', chunks.some((c) => String(c.heading).includes('顶层标题')));
ok('chunkText 行号有效', chunks.every((c) => c.startLine >= 1 && c.endLine >= c.startLine));
ok('chunkText 覆盖全文末句', chunks.some((c) => c.text.includes('行号必须准确')));
ok(
  'chunkText 同参可复现',
  JSON.stringify(ragChunk.chunkText(md, { size: 120, overlap: 20, minSize: 20 })) === JSON.stringify(chunks),
);
eq('chunkText 空文本返回空数组', ragChunk.chunkText('   \n\n'), []);

const toks = ragTokens.tokenize('Bonsai 三值量化 llama.cpp');
ok('tokenize 拉丁词', toks.includes('bonsai'));
ok('tokenize CJK 单字', toks.includes('量'));
ok('tokenize CJK 双字', toks.includes('量化'));
eq('tokenize 去重保序', ragTokens.queryTokens('bonsai bonsai rag'), ['bonsai', 'rag']);

// 建一个真实小知识库
const KB = path.join(TMP, 'kb');
fs.mkdirSync(path.join(KB, 'sub'), { recursive: true });
fs.writeFileSync(
  path.join(KB, 'guide.md'),
  '# 硬件\n\nBonsai 27B 需要 8GB 显存；-np 1 防止并发抢 GPU。\n\n# 检索\n\nRAG 用 BM25，命中块必须带 file:line。\n',
);
fs.writeFileSync(
  path.join(KB, 'sub', 'notes.txt'),
  'ctx 压缩：超过 72% 上下文时把前段压成摘要。\n唯一词 zebra-quokka 只在这里出现。\n',
);
fs.writeFileSync(path.join(KB, 'skip.bin'), Buffer.from([0, 1, 2, 3]));
const ragCfg = { rag: { root: KB, chunkSize: 200, overlap: 20, minSize: 20 } };
const meta = rag.buildIndex({ cfg: ragCfg, rebuild: true });
eq('buildIndex 只收文本件', meta.files, 2);
ok('buildIndex 有块', meta.chunks >= 2, String(meta.chunks));
ok('buildIndex 落了 index.json', fs.existsSync(path.join(TMP, 'rag', 'index.json')));
ok('buildIndex 落了 meta.json', fs.existsSync(path.join(TMP, 'rag', 'meta.json')));

const hit = rag.retrieve({ cfg: ragCfg, query: 'zebra-quokka 压缩' });
ok('retrieve 命中唯一词', hit.ok && hit.chunks[0].file.includes('notes.txt'), JSON.stringify(hit.reason || hit.chunks?.[0]?.file));
ok('retrieve 带出 sources', hit.ok && hit.sources.length === hit.chunks.length && hit.sources[0].id === 'S1');
ok('retrieve 带 file:line 出处', hit.ok && /\.(md|txt)$/.test(hit.sources[0].file) && hit.sources[0].startLine >= 1);
ok('retrieve 注入块含引用规则', hit.ok && hit.block.includes('[S1]') && hit.block.includes('引用'));
const miss = rag.retrieve({ cfg: ragCfg, query: 'zzz-no-such-token-xyz' });
ok('retrieve 无命中给原因', miss.ok === false && typeof miss.reason === 'string');
const otherRoot = rag.retrieve({ cfg: { rag: { root: path.join(TMP, 'other-root') } }, query: 'zebra-quokka' });
ok('retrieve 目录不一致拒检', otherRoot.ok === false && /目录/.test(otherRoot.reason), otherRoot.reason);

const ansOk = ragGround.verifyAnswer('显存要 8GB [S1]。', hit.chunks);
eq('verifyAnswer 合法引用通过', ansOk.ok, true);
eq('verifyAnswer 不存在的编号失败', ragGround.verifyAnswer('显存要 8GB [S9]。', hit.chunks).ok, false);
eq('verifyAnswer 有资料零引用失败', ragGround.verifyAnswer('显存要 8GB。', hit.chunks).ok, false);
eq('verifyAnswer 弃答通过', ragGround.verifyAnswer('资料不足：知识库里没有显卡价格。', hit.chunks).ok, true);
ok('verifyAnswer 摘录不符只告警', ragGround.verifyAnswer('显存要 8GB [S1]：「完全对不上的十来个字」', hit.chunks).ok === true);

/* ---------------- RAG 工具与权限 ---------------- */
const names0 = tools.allTools(config.loadConfig()).map((t) => t.name);
ok('allTools 含 rag_search', names0.includes('rag_search'));
ok('allTools 含 rag_index', names0.includes('rag_index'));
ok('关闭 rag 后不注册 rag 工具', !tools.allTools({ ...config.loadConfig(), rag: { enabled: false } }).some((t) => t.name === 'rag_search'));
eq('rag_search 风险=read', permission.riskOf('rag_search'), 'read');
eq('rag_index 风险=exec', permission.riskOf('rag_index'), 'exec');

/* ---------------- 上下文压缩（纯函数部分） ---------------- */
eq('contextSize 解析 -c 16384', compress.contextSize(config.loadConfig()), 16384);
eq('contextSize 解析自定义 -c', compress.contextSize({ llamacpp: { extraArgs: '-ngl 99 -c 4096 --jinja' } }), 4096);
eq('contextSize 缺省 8192', compress.contextSize({ llamacpp: { extraArgs: '-ngl 99' } }), 8192);
// v0.7.1：压缩阈值必须与 chat 裁剪同口径（端点实时 n_ctx 优先）。外部端点下 -c 写在别人的
// 启动脚本里，只看 extraArgs 会把 131072 的端点当 8192，长会话 ~4k token 就白烧一次摘要调用。
eq('contextSize 优先用端点实时 n_ctx', compress.contextSize({ llamacpp: { extraArgs: '' } }, 131072), 131072);
eq('contextSize 实时值压过 extraArgs -c', compress.contextSize({ llamacpp: { extraArgs: '-c 16384' } }, 131072), 131072);
eq('contextSize 实时值缺失时退回 -c', compress.contextSize({ llamacpp: { extraArgs: '-c 16384' } }, 0), 16384);
eq('estimateContext 用实时 n_ctx 当预算', compress.estimateContext({ messages: [] }, { llamacpp: { extraArgs: '' } }, 3000, 131072).budget, 131072);
const shortSession = { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好' }] };
eq('短历史不压缩', compress.planCompression(shortSession, config.loadConfig()).should, false);
const longMsgs = [];
for (let i = 0; i < 40; i += 1) longMsgs.push({ role: i % 2 ? 'assistant' : 'user', content: '很长的历史内容'.repeat(400) });
const longSession = { messages: longMsgs };
const plan = compress.planCompression(longSession, config.loadConfig());
ok('长历史要压缩', plan.should === true, JSON.stringify(plan));
ok('压缩切点落在 user 边界', longSession.messages[plan.cut]?.role === 'user', `cut=${plan.cut}`);
const sb = compress.summaryBlock({ summary: '早前摘要文本', summaryUpTo: 12 });
ok('summaryBlock 含摘要与覆盖条数', sb.includes('早前摘要文本') && sb.includes('12'));

/* ---------------- 记忆分层（v0.6.0） ---------------- */
const memory = await import('../model/memory.mjs');
const searchMod = await import('../model/search.mjs');

eq('记忆默认开启', config.loadConfig().memory.enabled, true);
eq('记忆注入总上限默认 2200', config.loadConfig().memory.injectMaxChars, 2200);
const slugA = memory.workspaceSlug('C:\\work\\Demo');
const slugB = memory.workspaceSlug('c:/work/demo');
eq('workspaceSlug 大小写无关（同一目录同一层）', slugA, slugB);
ok('workspaceSlug 只含安全字符', /^[a-z0-9._-]+$/.test(slugA), slugA);
ok('workspaceSlug 区分不同目录', memory.workspaceSlug('C:\\work\\other') !== slugA);
ok('key/project 落独立文件', memory.fileOf('key', { workspace: 'C:\\work\\Demo' }).includes('key') &&
  memory.fileOf('project', { workspace: 'C:\\work\\Demo' }).includes('project'));

const memCfg = { workspace: path.join(TMP, 'ws-demo'), memory: { ...config.loadConfig().memory } };
// v0.7.1：空记忆 = 机制在、没人喂。空库时补一条「顺手记」提示（必须趁还没写入时测）。
ok('空记忆给出一条写入提示', memory.memoryEmptyHint(memCfg).includes('memory 工具'), memory.memoryEmptyHint(memCfg));
const added = memory.addMemory({ cfg: memCfg, target: 'key', content: '本项目用 pnpm，不用 npm' });
ok('add 写入 key 层', added.ok && fs.existsSync(added.file) && added.count === 1, added.file);
ok('条目是单行 markdown', added.line.startsWith('- [') && added.line.includes('pnpm'), added.line);
memory.addMemory({ cfg: memCfg, target: 'user', content: '用户偏好中文' });
memory.addMemory({ cfg: memCfg, target: 'memory', content: '本机 8GB 显存' });
memory.addMemory({ cfg: memCfg, target: 'project', content: '完成 v0.6.0 记忆分层' });
const blk = memory.injectionBlock(memCfg);
ok('注入块含三层内容', blk.includes('pnpm') && blk.includes('中文') && blk.includes('8GB'), blk.slice(0, 160));
ok('注入块不含 project 层', !blk.includes('v0.6.0 记忆分层'), blk);
ok('注入块长度受上限约束', blk.length <= memCfg.memory.injectMaxChars, `${blk.length}`);
ok('注入块有总标题', blk.startsWith('【长期记忆'));
eq('关闭记忆后不注入', memory.injectionBlock({ ...memCfg, memory: { ...memCfg.memory, enabled: false } }), '');
eq('有记忆后不再给空库提示', memory.memoryEmptyHint(memCfg), '');
eq('关闭记忆后不给空库提示', memory.memoryEmptyHint({ ...memCfg, memory: { ...memCfg.memory, enabled: false } }), '');
const otherBlk = memory.injectionBlock({ workspace: path.join(TMP, 'ws-empty'), memory: memCfg.memory });
ok('换工作区不串 key 层（全局层仍注入）', !otherBlk.includes('pnpm') && otherBlk.includes('用户偏好中文'), otherBlk.slice(0, 160));
for (let i = 0; i < 30; i += 1) memory.addMemory({ cfg: memCfg, target: 'key', content: `${'很长的项目结论'.repeat(40)}#${i}` });
const blk2 = memory.injectionBlock(memCfg);
ok('层截断后总长仍受控', blk2.length <= memCfg.memory.injectMaxChars, `${blk2.length}`);
ok('条目总数上限内', memory.readEntries('key', memCfg).length <= memory.MAX_ENTRIES);
const dayOk = memory.appendDaily({ cfg: memCfg, text: '任务A → done（2 步，3 s，r_smoke）' });
ok('appendDaily 返回 true', dayOk === true);
const dayEntries = memory.readEntries('daily', memCfg);
ok('每日日志进当天文件', dayEntries.length === 1 && dayEntries[0].text.includes('任务A'), JSON.stringify(dayEntries));
ok('每日日志按日期命名', /daily[\\/]\d{4}-\d{2}-\d{2}\.md$/.test(memory.fileOf('daily', memCfg)), memory.fileOf('daily', memCfg));
eq('关闭每日日志后不写', memory.appendDaily({ cfg: { ...memCfg, memory: { ...memCfg.memory, daily: false } }, text: 'x' }), false);
const found = memory.searchMemory({ cfg: memCfg, query: 'pnpm' });
ok('searchMemory 跨层命中', found.count >= 1 && found.hits.some((h) => h.layer === 'key'), JSON.stringify(found.hits.slice(0, 2)));
const rem = memory.removeMemory({ cfg: memCfg, target: 'key', match: 'pnpm' });
ok('remove 删除唯一命中', rem.ok && !memory.readEntries('key', memCfg).some((e) => e.text.includes('pnpm')), JSON.stringify(rem));
let ambErr = '';
try {
  memory.removeMemory({ cfg: memCfg, target: 'key', match: '很长的项目结论' });
} catch (e) {
  ambErr = e.message;
}
ok('remove 多条命中时报错', ambErr.length > 0, ambErr);
let badLayer = '';
try {
  memory.addMemory({ cfg: memCfg, target: 'nope', content: 'x' });
} catch (e) {
  badLayer = e.message;
}
ok('未知记忆层报错', badLayer.includes('不认识的记忆层'), badLayer);
ok('memoryStats 五层齐全', memory.memoryStats(memCfg).layers.length === 5);
ok('memoryStatus 不带注入块', memory.memoryStatus(memCfg).layers.every((l) => !('preview' in l)));

/* ---------------- 记忆工具 + 搜索后端（v0.6.0） ---------------- */
const memToolNames = tools.allTools(config.loadConfig()).map((t) => t.name);
ok('allTools 含 memory', memToolNames.includes('memory'));
ok(
  '关闭 memory 后不注册工具',
  !tools.allTools({ ...config.loadConfig(), memory: { enabled: false } }).some((t) => t.name === 'memory'),
);
eq('memory 风险=write', permission.riskOf('memory'), 'write');
const memToolOut = await tools.execTool('memory', { action: 'list', target: 'user' }, { cfg: memCfg });
ok('memory 工具 list 可执行', memToolOut.ok && memToolOut.output.includes('用户偏好中文'), memToolOut.output);
const memToolErr = await tools.execTool('memory', { action: 'add', target: 'key' }, { cfg: memCfg });
ok('memory 工具缺 content 报错', memToolErr.ok === false && memToolErr.output.includes('不能为空'), memToolErr.output);
const memDisabled = await tools.execTool('memory', { action: 'list' }, { cfg: { ...memCfg, memory: { enabled: false } } });
ok('关闭记忆时工具明确报错', memDisabled.ok === false && memDisabled.output.includes('关闭'), memDisabled.output);
eq('resolveEngines 锁定 bing', searchMod.resolveEngines('bing'), ['bing']);
eq('resolveEngines ddg 别名', searchMod.resolveEngines('duckduckgo'), ['duckduckgo']);
eq('resolveEngines auto 默认顺序', searchMod.resolveEngines('auto'), ['bing', 'duckduckgo']);
ok('searchCacheSize 是数字', typeof searchMod.searchCacheSize() === 'number');
ok(
  'formatResults 标缓存',
  searchMod.formatResults('q', [{ title: 't', url: 'https://e.com', snippet: 's' }], 'bing', true).includes('缓存'),
);

/* ---------------- 思考路径（PSV）与内置回执 ---------------- */
const thinking = await import('../model/thinking.mjs');
const receipt = await import('../model/receipt.mjs');

eq('思考路径 4 阶段', thinking.THINKING_PATH.stages.map((s) => s.key), ['plan', 'ground', 'answer', 'verify']);
eq('思考路径默认开启', thinking.thinkingOptions(config.loadConfig()).enabled, true);
const tb = thinking.buildThinkingBlock(config.loadConfig(), { steps: ['读资料', '作答', '自检'], source: 'llm' });
ok('思考块含路径与计划', tb.includes('计划→取证→作答→自检') && tb.includes('【本轮计划】') && tb.includes('1) 读资料'));
eq('关闭思考路径时不注入', thinking.buildThinkingBlock({ thinking: { enabled: false } }, null), '');
eq('parsePlan 解析编号列表', thinking.parsePlan('1. 读资料\n2) 依据作答\n- 收尾自检\n无编号行'), ['读资料', '依据作答', '收尾自检']);
eq('parsePlan 尊重上限', thinking.parsePlan('1. 第一步\n2. 第二步\n3. 第三步\n4. 第四步', 2).length, 2);
ok(
  'planRequest 带资料出处',
  thinking.planRequest({ task: '任务', sources: [{ id: 'S1', file: 'a.md', heading: 'h', startLine: 1, endLine: 2 }] }).includes('[S1] a.md'),
);
eq('fallbackPlan 有资料=3 步', thinking.fallbackPlan({ rag: { sources: [{ id: 'S1' }] } }).steps.length, 3);
eq('fallbackPlan 无资料=3 步', thinking.fallbackPlan({}).steps.length, 3);
ok('checkAnswerPath 全结构 ok', thinking.checkAnswerPath('结论：x\n依据 [S1]\n自检：无未验证项').ok);
ok('checkAnswerPath 缺自检在 require 下不过', thinking.checkAnswerPath('结论：x\n依据 [S1]', { requireSelfCheck: true }).ok === false);
ok('checkAnswerPath 缺结论记 missing', thinking.checkAnswerPath('随便一段话').missing.includes('结论段'));

const recCtx = {
  runId: 'r_testreceipt1',
  sessionId: 's_test1',
  task: '验证回执',
  status: 'done',
  error: null,
  model: 'llama/bonsai-2-27b',
  permission: 'full-access',
  think: false,
  startedAt: 1000,
  endedAt: 6000,
  events: [
    { type: 'step', n: 1 },
    { type: 'thinking_plan', steps: ['读资料', '作答', '自检'], source: 'llm', ms: 120 },
    { type: 'rag_retrieved', query: 'q', matched: 3, chunks: 2, chars: 500, tookMs: 2, sources: [{ id: 'S1', file: 'a.md', heading: 'h', startLine: 1, endLine: 9 }] },
    { type: 'rag_verify', ok: true, cites: ['S1'], reasons: [], warnings: [] },
    { type: 'tool_end', callId: 'c1', name: 'read_file', ok: true, ms: 5, output: 'ok' },
    { type: 'tool_start', callId: 'c2', name: 'write_file', args: { path: 'out.txt' } },
    { type: 'tool_end', callId: 'c2', name: 'write_file', ok: true, ms: 3, output: 'ok' },
    { type: 'thinking_verify', ok: true, hasConclusion: true, hasBasis: true, hasSelfCheck: true, missing: [] },
    { type: 'usage', promptEval: 1200, evalCount: 300, evalMs: 8000, totalMs: 9000, tps: 37.5 },
    { type: 'assistant_done', content: '结论：可以。\n依据 [S1]。\n自检：无未验证项。' },
  ],
};
const built = receipt.buildReceipt(recCtx);
ok('回执标题含 runId', built.md.includes('# 回执报告 · r_testreceipt1'));
ok('回执结论先行', built.md.includes('**结论**：✅ 完成'));
for (const sec of ['## 结论', '## 做了什么', '## 验收证据', '## 边界与未验证', '## 下一步']) ok(`回执含 ${sec}`, built.md.includes(sec));
ok('回执行含计划与引用', built.md.includes('思考路径 · 计划') && built.md.includes('[S1] a.md'));
ok('回执行含触及文件', built.md.includes('`out.txt`'));
eq('回执 JSON 状态', built.json.status, 'done');
eq('回执 JSON 计划步数', built.json.plan.steps.length, 3);
eq('回执 JSON 工具调用数', built.json.toolCalls.length, 2);
eq('回执 JSON 带版本', built.json.receipt.version, receipt.RECEIPT_VERSION);
const w = receipt.writeReceipt(recCtx);
ok('回执 md 落盘', fs.existsSync(w.mdPath) && w.bytes > 800, `bytes=${w.bytes}`);
ok('回执 json 落盘', fs.existsSync(w.jsonPath));
let badRunId = false;
try {
  receipt.contextFromRunDisk('bad-id');
} catch {
  badRunId = true;
}
ok('非法 runId 拒绝重建', badRunId);
ok('内置回执默认开启', config.loadConfig().receipt.enabled === true);

/* ---------------- 静态断言：这条线真的不碰 Ollama ---------------- */
ok('没有 model/ollama.mjs', !fs.existsSync(path.join(ROOT, 'model', 'ollama.mjs')));
ok('没有 model/embeddings.mjs', !fs.existsSync(path.join(ROOT, 'model', 'embeddings.mjs')));
ok('没有 model/hardware.mjs', !fs.existsSync(path.join(ROOT, 'model', 'hardware.mjs')));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
eq('package 名', pkg.name, 'bonsai-workbench');
eq('package 版本', pkg.version, '0.7.1');

const appCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bonsai.config.json'), 'utf8'));
eq('应用配置默认模型', appCfg.model, 'llama/bonsai-2-27b');
// v0.6.0 起改为「外部端点」口径：GPU 让给 D:\llm\ada 的 ada llama-server（8080），
// 工作台只管连、不自己拉进程（同一张 8GB 卡，两个 server 必抢显存 → failed to create context）。
ok('应用配置是外部端点（不配托管运行时）', !appCfg.llamacpp.serverPath && !appCfg.llamacpp.modelPath, appCfg.llamacpp.serverPath);
ok('应用配置显式 mode=external（一键切换的落点）', appCfg.llamacpp.mode === 'external', appCfg.llamacpp.mode);
ok('应用配置连 ada 端点 8080（外部端点，不自己拉服务）', /:8080$/.test(appCfg.llamacpp.host || ''), appCfg.llamacpp.host);
ok('应用配置端点不自启（显存让给 ada 服务）', appCfg.llamacpp.autostart === false);
ok('应用配置用 key 文件做 Bearer 鉴权', /api_key\.txt$/i.test(appCfg.llamacpp.apiKeyFile || ''), appCfg.llamacpp.apiKeyFile);
ok('应用配置模型别名对上服务端 /v1/models', appCfg.llamacpp.alias === 'bonsai-2-27b', appCfg.llamacpp.alias);
// 0.5.1：实测投机解码（ngram-mod）在首轮生成上 0 收益（drafts=0），默认不开；要开走 config 手改
ok('应用配置不默认开投机解码', !String(appCfg.llamacpp.extraArgs || '').includes('--spec-type'), appCfg.llamacpp.extraArgs);
// 0.5.1：曾经被写成 1e+104（Infinity 序列化产物），clamp 到 4000 后摘要白长 3.3 倍
ok(
  '应用配置 summaryChars 落在 clamp 区间 [200,4000]',
  Number(appCfg.ctx.summaryChars) >= 200 && Number(appCfg.ctx.summaryChars) <= 4000,
  String(appCfg.ctx.summaryChars),
);
ok('性能基准工具 test/bench.mjs 在册', fs.existsSync(path.join(ROOT, 'test', 'bench.mjs')));

/* ---------------- v0.7.1：开箱可用（RAG 跟随工作区 / 启动自动建索引 / 技能面板信噪比） ---------------- */
eq('应用配置 RAG 根跟随工作区（不再钉在自身 docs/）', appCfg.rag.root, '');
ok(
  '启动时自动建知识库索引（缺索引或目录变了）',
  /buildRagIndex\(\{\s*cfg\s*\}\)/.test(fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')),
);
const appJs = fs.readFileSync(path.join(ROOT, 'view', 'app.js'), 'utf8');
ok('技能面板先列已启用、未启用收进展开小节', appJs.includes('其余 ') && appJs.includes('offSkills'), '');
ok('技能面板有计数行', /技能 \$\{allSkills\.length\} 条，已启用 \$\{onSkills\.length\} 条/.test(appJs));

/* ---------------- 收尾 ---------------- */
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录删不掉不影响结论 */
}

if (failures.length) {
  console.error(`SMOKE FAIL ${failures.length} 项失败 / ${passed} 项通过`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log(`SMOKE PASS ${passed} 项通过，0 项失败`);
