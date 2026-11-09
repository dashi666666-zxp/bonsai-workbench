/**
 * 技能（skills）子系统 —— 零依赖，按目录扫描 SKILL.md。
 *
 * 目录约定（与 DSH 技能库同构）：
 *   <dir>/<技能名>/SKILL.md      frontmatter 里有 name / description
 *   <dir>/<技能名>.md            也可以（单文件技能）
 *
 * 扫描根默认：~/.agents/skills 与 ~/.dsh/skills（可用 BW_SKILLS 环境变量或
 * 配置项 skillsDirs 覆盖；配置项优先级最高）。
 *
 * 开关状态落在 <OW_DATA>/skill-toggles.json：{ "<技能名>": false }
 *   - 只记「被关掉的」、不记默认态，这样新装技能默认可用
 *   - frontmatter 的 disable-model-invocation: true 走同一套开关（默认关）
 *
 * 渐进式披露：模型只看到「名字 + 一句话描述」的目录，需要细节时调用
 * skill(name) 工具拿 SKILL.md 全文 + 技能基目录（references/ 自己按需读）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './config.mjs';

export const DEFAULT_SKILL_DIRS = [
  path.join(os.homedir(), '.agents', 'skills'),
  path.join(os.homedir(), '.dsh', 'skills'),
];

const STATE_FILE = process.env.BW_SKILL_STATE || path.join(DATA_DIR, 'skill-toggles.json');
const MAX_SKILL_FILE_BYTES = 512 * 1024;

/** @type {Map<string, {name:string,description:string,dir:string,file:string,enabled:boolean,error:string,chars:number,sourceDir:string,shadowed:string}>} */
const registry = new Map();
let scannedAt = 0;

/* ---------------- frontmatter ---------------- */

/** 截取并解析最简 YAML frontmatter（只认 name/description/disable-model-invocation 等标量） */
export function parseFrontmatter(text) {
  const s = String(text ?? '');
  if (!s.startsWith('---')) return { meta: {}, body: s };
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  if (!m) return { meta: {}, body: s };
  const raw = m[1];
  const body = s.slice(m[0].length);
  const meta = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    // 折叠/块标量：>- | > |-
    if (/^[>|][+-]?$/.test(val)) {
      const buf = [];
      while (i + 1 < lines.length && (/^\s{2,}/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        buf.push(lines[++i].trim());
      }
      meta[key] = buf.join(val.startsWith('|') ? '\n' : ' ').trim();
      continue;
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body };
}

/* ---------------- 开关状态 ---------------- */

function readToggles() {
  try {
    const v = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeToggles(t) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(t, null, 2), 'utf8');
}

export function toggleFile() {
  return STATE_FILE;
}

/* ---------------- 扫描 ---------------- */

export function skillDirs(cfg) {
  const fromCfg = Array.isArray(cfg?.skillsDirs) ? cfg.skillsDirs.filter(Boolean) : [];
  const fromEnv = String(process.env.BW_SKILLS || '')
    .split(path.delimiter)
    .filter(Boolean);
  const dirs = fromCfg.length ? fromCfg : fromEnv.length ? fromEnv : DEFAULT_SKILL_DIRS;
  return dirs.map((d) => path.resolve(String(d).replace(/^~(?=$|[\\/])/, os.homedir())));
}

function readSkillFile(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_SKILL_FILE_BYTES) throw new Error(`SKILL.md 过大（${st.size} 字节，上限 ${MAX_SKILL_FILE_BYTES}）`);
  return fs.readFileSync(file, 'utf8');
}

/**
 * 扫描技能目录并重建注册表。永远不抛异常：坏技能只记 error。
 * @param {object} [cfg]
 * @returns {{ skills: object[], dirs: string[], stateFile: string }}
 */
export function loadSkills(cfg) {
  registry.clear();
  const toggles = readToggles();
  const dirs = skillDirs(cfg);
  scannedAt = Date.now();

  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在＝没装技能，不是错误
    }
    for (const ent of entries) {
      const rec = {
        name: '',
        description: '',
        dir: '',
        file: '',
        enabled: true,
        error: '',
        chars: 0,
        sourceDir: dir,
        shadowed: '',
      };
      try {
        let file = '';
        let baseDir = '';
        if (ent.isDirectory()) {
          baseDir = path.join(dir, ent.name);
          file = path.join(baseDir, 'SKILL.md');
          if (!fs.existsSync(file)) continue; // 不是技能目录（references/ 之类）
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
          baseDir = dir;
          file = path.join(dir, ent.name);
        } else {
          continue;
        }
        const text = readSkillFile(file);
        const { meta } = parseFrontmatter(text);
        const name = String(meta.name || (ent.isDirectory() ? ent.name : ent.name.replace(/\.md$/i, ''))).trim();
        if (!name) throw new Error('技能没有名字');
        if (registry.has(name)) {
          // 同名技能：先扫到的生效，后来的记 shadowed（不静默覆盖）
          registry.set(name, { ...registry.get(name), shadowed: file });
          continue;
        }
        rec.name = name;
        rec.description = String(meta.description || '').replace(/\s+/g, ' ').trim();
        rec.dir = baseDir;
        rec.file = file;
        rec.chars = text.length;
        const offByFrontmatter = String(meta['disable-model-invocation'] ?? '').toLowerCase() === 'true';
        const tk = toggles[name];
        // 用户显式开关优先（true/false 都算显式）；没点过才看 frontmatter 的 disable-model-invocation
        rec.enabled = tk === undefined ? !offByFrontmatter : tk !== false;
        registry.set(name, rec);
      } catch (e) {
        const name = String(ent.name || '').replace(/\.md$/i, '');
        rec.name = name;
        rec.error = String(e?.message || e);
        rec.file = path.join(dir, ent.name);
        rec.dir = rec.file;
        if (!registry.has(name)) registry.set(name, rec);
      }
    }
  }

  return { skills: skillList(), dirs, stateFile: STATE_FILE };
}

/** 状态清单（可 JSON 化，不含正文） */
export function skillList() {
  return [...registry.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({
      name: r.name,
      description: r.description,
      dir: r.dir,
      file: r.file,
      enabled: r.enabled,
      error: r.error,
      chars: r.chars,
      sourceDir: r.sourceDir,
      shadowed: r.shadowed || '',
    }));
}

export function skillStatus() {
  const skills = skillList();
  return {
    dirs: [...new Set(skills.map((s) => s.sourceDir))],
    stateFile: STATE_FILE,
    scannedAt,
    total: skills.length,
    enabled: skills.filter((s) => s.enabled && !s.error).length,
    skills,
  };
}

/** 开关一个技能（写落盘文件后即时生效） */
export function setSkillEnabled(name, enabled) {
  const key = String(name || '').trim();
  const rec = registry.get(key);
  if (!rec) return { ok: false, error: `没有叫 ${key} 的技能` };
  const toggles = readToggles();
  // 显式写 true 才能压过 frontmatter 的 disable-model-invocation（删 key 会退回默认关）
  toggles[key] = Boolean(enabled);
  writeToggles(toggles);
  rec.enabled = Boolean(enabled);
  return { ok: true, name: key, enabled: rec.enabled, stateFile: STATE_FILE };
}

/** 全部开/关（都写显式值，保证「全开」能压过 frontmatter 的默认关） */
export function setAllSkillsEnabled(enabled) {
  const toggles = readToggles();
  for (const rec of registry.values()) {
    if (rec.error) continue;
    toggles[rec.name] = Boolean(enabled);
    rec.enabled = Boolean(enabled);
  }
  writeToggles(toggles);
  return { ok: true, enabled: Boolean(enabled), total: registry.size };
}

/**
 * 系统提示里注入的技能目录（只名字+描述，正文按需用 skill 工具加载）。
 * @returns {{ text: string, count: number, chars: number, truncated: boolean }}
 */
export function skillsCatalogBlock(cfg) {
  const empty = { text: '', count: 0, chars: 0, truncated: false };
  if (cfg?.skillsEnabled === false) return empty;
  const maxChars = Math.max(500, Number(cfg?.skillsInjectMaxChars) || 6000);
  const list = [...registry.values()].filter((r) => r.enabled && !r.error && r.description);
  if (!list.length) return empty;
  const head = '可用技能（SKILL.md 全文不在上下文里；需要时调用 skill(name) 加载）：';
  const lines = [];
  let used = head.length;
  let truncated = false;
  for (const r of list) {
    const line = `- ${r.name}: ${r.description}`;
    if (used + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const tail = truncated ? `\n（共 ${list.length} 个技能，目录已按长度截断）` : '';
  const text = [head, ...lines].join('\n') + tail;
  return { text, count: lines.length, chars: text.length, truncated };
}

/** 加载技能全文（skill 工具的实现） */
export function loadSkillBody(name) {
  const rec = registry.get(String(name || '').trim());
  if (!rec) {
    const names = [...registry.keys()].slice(0, 50).join(', ');
    return { ok: false, output: `err: 没有叫 ${name || '(空)'} 的技能。可用技能：${names || '(无)'}` };
  }
  if (rec.error) return { ok: false, output: `err: 技能 ${rec.name} 扫描失败：${rec.error}` };
  if (!rec.enabled) return { ok: false, output: `err: 技能 ${rec.name} 已停用（设置 → 技能 里可以打开）` };
  let text;
  try {
    text = fs.readFileSync(rec.file, 'utf8');
  } catch (e) {
    return { ok: false, output: `err: 读不到 ${rec.file}：${e?.message || e}` };
  }
  const { body } = parseFrontmatter(text);
  const base = rec.dir.includes(path.sep) && rec.dir !== rec.file ? rec.dir : path.dirname(rec.file);
  const head = [
    `技能：${rec.name}`,
    `基目录：${base}（references/、scripts/ 等资源按需用 read_file 读）`,
    rec.description ? `描述：${rec.description}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  const cut = body.length > 60000 ? `${body.slice(0, 60000)}\n\n（技能正文过长，已截断 ${body.length - 60000} 字符）` : body;
  return { ok: true, output: head + cut };
}

export function closeSkills() {
  registry.clear();
}
