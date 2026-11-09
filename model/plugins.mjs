/**
 * 插件系统（零依赖，进程内加载）。
 *
 * 目录约定：
 *   <OW_DATA>/plugins/<插件名>/plugin.json   { name?, version?, description?, main?, enabled? }
 *   <OW_DATA>/plugins/<插件名>/index.mjs     默认入口，导出 { tools?: [...], hooks?: {...}, promptHint?, init? }
 *
 * 钩子（hooks）：{ runEnd?: async (ctx) => void } —— run 结束（done/stopped/error）后由
 * controller/runs.mjs 调用，用来做「做完任务写回执」这类收尾动作。钩子：
 *   - 只是旁路观察，返回值和异常都不影响 run 的结果（异常只记 hookErrors）；
 *   - 停用的插件钩子不触发；一个插件只有 hooks、没有 tools 也允许（钩子型插件）。
 *
 * 插件工具名统一 plugin__<插件>__<工具>，与内置工具、mcp__ 工具都不冲突。
 * 插件是**本地进程内代码**（等同自己写的脚本，没有沙箱），所以：
 *   - 风险级一律按 exec（只读档会被拦住），不采信插件自报的 risk（自报 read 就能在只读档跑起来）；
 *     自报值只作参考放进 declaredRisk 字段；
 *   - 加载/执行失败都不抛到 agent 循环，只记 error。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from './config.mjs';

export const PLUGIN_PREFIX = 'plugin__';
export const PLUGIN_DIR = process.env.BW_PLUGINS || path.join(DATA_DIR, 'plugins');
// 开关状态单独一个文件：插件目录是用户手放的，不该为了让插件停用去改它的 plugin.json
const TOGGLE_FILE = process.env.BW_PLUGIN_STATE || path.join(DATA_DIR, 'plugin-toggles.json');

const RISKS = new Set(['read', 'write', 'net', 'exec']);
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
const PLUGIN_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** @type {Map<string, {name:string,version:string,description:string,dir:string,enabled:boolean,tools:object[],hooks:object,error:string,loadedAt:number,hookErrors:object[]}>} */
const registry = new Map();

/* ---------------- 开关状态（<OW_DATA>/plugin-toggles.json） ---------------- */

function readToggles() {
  try {
    const v = JSON.parse(fs.readFileSync(TOGGLE_FILE, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeToggles(t) {
  fs.mkdirSync(path.dirname(TOGGLE_FILE), { recursive: true });
  fs.writeFileSync(TOGGLE_FILE, JSON.stringify(t, null, 2), 'utf8');
}

export function toggleFile() {
  return TOGGLE_FILE;
}

export function pluginToggles() {
  return readToggles();
}

export function pluginToolName(plugin, tool) {
  return `${PLUGIN_PREFIX}${plugin}__${tool}`;
}

export function parsePluginToolName(full) {
  const s = String(full || '');
  if (!s.startsWith(PLUGIN_PREFIX)) return null;
  const rest = s.slice(PLUGIN_PREFIX.length);
  const i = rest.indexOf('__');
  if (i <= 0) return null;
  return { plugin: rest.slice(0, i), tool: rest.slice(i + 2) };
}

function paramHint(localName, parameters) {
  const props = parameters && parameters.properties ? Object.keys(parameters.properties) : [];
  return `${localName}(${props.join(', ')})`;
}

function normalizeTool(plugin, t) {
  const name = String(t?.name || '').trim();
  if (!TOOL_NAME_RE.test(name)) {
    throw new Error(`工具名不合规（要小写字母开头的 [a-z0-9_]，≤48 字符）：${name || '(空)'}`);
  }
  if (typeof t.run !== 'function') throw new Error(`工具 ${name} 缺少 run 函数`);
  const parameters = t.parameters && t.parameters.type === 'object'
    ? t.parameters
    : { type: 'object', properties: {} };
  return {
    name: pluginToolName(plugin, name),
    localName: name,
    plugin,
    source: 'plugin',
    // 插件是进程内任意代码，风险不能由插件自报（自报 read 就能在只读档跑起来）。
    // 一律按 exec 处理，与 permission.mjs 的 riskOf('plugin__…') 保持一致。
    risk: 'exec',
    declaredRisk: RISKS.has(t.risk) ? t.risk : null,
    hint: t.hint || `${paramHint(name, parameters)} 来自插件 ${plugin}`,
    description: t.description || `插件 ${plugin} 提供的 ${name}`,
    parameters,
    run: t.run,
  };
}

/**
 * 扫描插件目录并（重新）加载。永远不抛异常：坏插件只记 error。
 * @param {object} [cfg]
 * @param {{dir?:string}} [opts]
 * @returns {Promise<Array<object>>} 与 pluginStatus() 相同结构
 */
export async function loadPlugins(cfg, opts = {}) {
  const dir = opts.dir || PLUGIN_DIR;
  registry.clear();
  const toggles = readToggles();
  fs.mkdirSync(dir, { recursive: true });

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return pluginStatus();
  }

  for (const ent of entries) {
    const name = ent.name;
    const pdir = path.join(dir, name);
    const rec = {
      name,
      version: '',
      description: '',
      dir: pdir,
      enabled: true,
      tools: [],
      hooks: {},
      error: '',
      loadedAt: 0,
      hookErrors: [],
    };
    try {
      if (!PLUGIN_NAME_RE.test(name)) throw new Error('目录名不合规（要小写字母开头，可含 - 与 _）');
      const manifestPath = path.join(pdir, 'plugin.json');
      if (!fs.existsSync(manifestPath)) throw new Error('缺少 plugin.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      rec.version = String(manifest.version || '');
      rec.description = String(manifest.description || '');
      // 停用的判定：manifest 里 enabled:false（插件作者声明）或用户在界面上关过
      // 停用只摘工具（pluginToolDefs 过滤），模块照样 import —— 这样开关切回来不用重扫，
      // 状态清单里也始终能显示「几个工具」，不会一关就变 0。
      if (manifest.enabled === false || toggles[name] === false) rec.enabled = false;
      const main = String(manifest.main || 'index.mjs');
      const mainPath = path.resolve(pdir, main);
      if (!mainPath.startsWith(path.resolve(pdir) + path.sep)) throw new Error('main 不能指到插件目录外');
      if (!fs.existsSync(mainPath)) throw new Error(`入口不存在：${main}`);

      const st = fs.statSync(mainPath);
      const mod = await import(`${pathToFileURL(mainPath).href}?v=${st.mtimeMs}`);
      const rawTools = Array.isArray(mod.tools) ? mod.tools : Array.isArray(mod.default?.tools) ? mod.default.tools : [];
      // 钩子也是插件能力：只做收尾的插件（如回执生成器）允许没有 tools。
      const rawHooks = (mod.hooks && typeof mod.hooks === 'object' ? mod.hooks : null)
        || (mod.default?.hooks && typeof mod.default.hooks === 'object' ? mod.default.hooks : null)
        || {};
      const hookFns = {};
      for (const [k, fn] of Object.entries(rawHooks)) if (typeof fn === 'function') hookFns[k] = fn;
      if (!rawTools.length && !Object.keys(hookFns).length) throw new Error('没有导出 tools 数组或 hooks');
      rec.tools = rawTools.map((t) => normalizeTool(name, t));
      rec.hooks = hookFns;
      rec.loadedAt = Date.now();
      const init = mod.init || mod.default?.init;
      if (rec.enabled && typeof init === 'function') await init({ cfg, pluginDir: pdir, dataDir: DATA_DIR });
      registry.set(name, rec);
    } catch (e) {
      rec.error = String(e?.message || e);
      rec.tools = [];
      registry.set(name, rec);
    }
  }
  return pluginStatus();
}

/** 所有插件工具定义（供 allTools 合并） */
export function pluginToolDefs() {
  const out = [];
  for (const rec of registry.values()) {
    if (rec.enabled && !rec.error) out.push(...rec.tools);
  }
  return out;
}

/** 状态清单（不含 run 函数，可安全 JSON 化） */
export function pluginStatus() {
  return [...registry.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({
      name: r.name,
      version: r.version,
      description: r.description,
      enabled: r.enabled,
      error: r.error,
      loadedAt: r.loadedAt,
      hooks: Object.keys(r.hooks || {}),
      hookErrors: (r.hookErrors || []).slice(-3).map((h) => ({ event: h.event, at: h.at, error: h.error })),
      tools: r.tools.map((t) => ({ name: t.localName, fullName: t.name, risk: t.risk, hint: t.hint })),
    }));
}

export function pluginDir() {
  return PLUGIN_DIR;
}

/**
 * 开关一个插件（落盘后由调用方重载生效）。
 * @returns {{ok:boolean, name?:string, enabled?:boolean, error?:string, stateFile?:string}}
 */
export function setPluginEnabled(name, enabled) {
  const key = String(name || '').trim();
  const rec = registry.get(key);
  if (!rec) return { ok: false, error: `没有叫 ${key} 的插件` };
  const toggles = readToggles();
  if (enabled) delete toggles[key];
  else toggles[key] = false;
  writeToggles(toggles);
  rec.enabled = Boolean(enabled);
  return { ok: true, name: key, enabled: rec.enabled, stateFile: TOGGLE_FILE };
}

/** 全部开/关（逐个写；开＝清掉开关文件里的记录） */
export function setAllPluginsEnabled(enabled) {
  const toggles = readToggles();
  for (const rec of registry.values()) {
    if (enabled) delete toggles[rec.name];
    else toggles[rec.name] = false;
    rec.enabled = Boolean(enabled);
  }
  writeToggles(toggles);
  return { ok: true, enabled: Boolean(enabled), total: registry.size, stateFile: TOGGLE_FILE };
}

/**
 * 调用插件工具。
 * @returns {Promise<{ok:boolean, output:string}>}
 */
export async function callPluginTool(fullName, args, ctx) {
  const parsed = parsePluginToolName(fullName);
  if (!parsed) return { ok: false, output: `err: 不是插件工具名：${fullName}` };
  const rec = registry.get(parsed.plugin);
  if (!rec) return { ok: false, output: `err: 没有叫 ${parsed.plugin} 的插件` };
  if (rec.error) return { ok: false, output: `err: 插件 ${parsed.plugin} 加载失败：${rec.error}` };
  if (!rec.enabled) return { ok: false, output: `err: 插件 ${parsed.plugin} 已停用` };
  const def = rec.tools.find((t) => t.localName === parsed.tool);
  if (!def) return { ok: false, output: `err: 插件 ${parsed.plugin} 没有工具 ${parsed.tool}` };
  try {
    const v = await def.run(args && typeof args === 'object' ? args : {}, ctx || {});
    if (v == null) return { ok: true, output: '(无输出)' };
    if (typeof v === 'string') return { ok: true, output: v };
    if (typeof v === 'object' && typeof v.output !== 'undefined') {
      return { ok: v.ok !== false, output: String(v.output) };
    }
    return { ok: true, output: JSON.stringify(v, null, 2) };
  } catch (e) {
    return { ok: false, output: `err: 插件 ${parsed.plugin}/${parsed.tool} 执行失败：${e?.message || e}` };
  }
}

export function closePlugins() {
  registry.clear();
}

/**
 * 触发所有已启用插件的某个钩子（按插件名顺序串行，单插件失败不影响其它插件，也不抛给调用方）。
 * @param {string} event 'runEnd'
 * @param {object} payload 传给钩子的上下文（runEnd: {runId,sessionId,task,status,error,startedAt,endedAt,model,permission,think,events,session,cfg,dataDir}）
 * @returns {Promise<Array<{plugin:string, ok:boolean, error?:string}>>}
 */
export async function runPluginHooks(event, payload) {
  const out = [];
  for (const rec of [...registry.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!rec.enabled || rec.error) continue;
    const fn = rec.hooks?.[event];
    if (typeof fn !== 'function') continue;
    try {
      await fn(payload);
      out.push({ plugin: rec.name, ok: true });
    } catch (e) {
      const err = String(e?.message || e);
      rec.hookErrors.push({ event, at: Date.now(), error: err });
      if (rec.hookErrors.length > 20) rec.hookErrors.shift();
      out.push({ plugin: rec.name, ok: false, error: err });
    }
  }
  return out;
}
