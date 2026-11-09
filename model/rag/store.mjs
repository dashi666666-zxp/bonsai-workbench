/**
 * 知识库索引：扫描目录 → 切片 → 词频 → 落盘 JSON（零依赖、可增量）
 *
 * 索引文件：<BW_DATA>/rag/index.json（大件，含块正文与 tf）
 * 状态文件：<BW_DATA>/rag/meta.json（小件，面板/状态接口只读它）
 *
 * 增量口径：按 (size, mtimeMs) 判断文件是否变过，未变则复用旧块；
 * 删掉的文件自然不进新索引。分块参数变了（size/overlap/minSize）就整体重建。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.mjs';
import { DEFAULT_CHUNK, chunkText } from './chunk.mjs';
import { tokenize } from './tokens.mjs';

export const INDEX_VERSION = 1;
export const RAG_DIR = path.join(DATA_DIR, 'rag');
const INDEX_FILE = path.join(RAG_DIR, 'index.json');
const META_FILE = path.join(RAG_DIR, 'meta.json');

export const DEFAULT_INCLUDE = [
  'md', 'markdown', 'txt', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'lua', 'kt', 'swift',
  'sh', 'ps1', 'bat', 'cmd', 'css', 'scss', 'html', 'htm', 'xml', 'yml', 'yaml',
  'toml', 'ini', 'cfg', 'conf', 'sql', 'csv', 'tsv', 'log', 'vue', 'svelte',
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '__pycache__', '.venv',
  'venv', 'dist', 'build', 'target', '.next', '.nuxt', '.cache', 'coverage',
  '.gradle', '.mvn', 'obj', 'bin', '.turbo', '.parcel-cache', '.pytest_cache',
]);

const BINARY_PROBE = 8192;

export function ragOptions(cfg) {
  const r = cfg?.rag || {};
  const size = Math.max(200, Number(r.chunkSize) || DEFAULT_CHUNK.size);
  return {
    root: String(r.root || '').trim(),
    size,
    overlap: Math.max(0, Math.min(Number(r.overlap ?? DEFAULT_CHUNK.overlap), Math.floor(size / 2))),
    minSize: Math.max(0, Number(r.minSize ?? DEFAULT_CHUNK.minSize)),
    maxFileBytes: Math.max(4096, Number(r.maxFileBytes) || 1_500_000),
    maxFiles: Math.max(1, Number(r.maxFiles) || 1500),
    maxChunks: Math.max(1, Number(r.maxChunks) || 5000),
    include: Array.isArray(r.include) && r.include.length ? r.include.map((x) => String(x).toLowerCase().replace(/^\./, '')) : DEFAULT_INCLUDE,
  };
}

export function resolveRagRoot(cfg) {
  const o = ragOptions(cfg);
  return path.resolve(o.root || cfg?.workspace || process.cwd());
}

function walkFiles(root, opts) {
  const files = [];
  const stack = [''];
  let dirs = 0;
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    dirs += 1;
    for (const ent of entries) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.')) continue;
        if (SKIP_DIRS.has(ent.name.toLowerCase())) continue;
        stack.push(childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (!opts.include.includes(ext)) continue;
      files.push(childRel);
    }
  }
  files.sort();
  if (files.length > opts.maxFiles) files.length = opts.maxFiles;
  return { files, dirs };
}

function readTextFile(abs, maxBytes) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > maxBytes || st.size === 0) return null;
    const fd = fs.openSync(abs, 'r');
    try {
      const probe = Buffer.alloc(Math.min(BINARY_PROBE, st.size));
      fs.readSync(fd, probe, 0, probe.length, 0);
      if (probe.includes(0)) return null; // 二进制直接跳过
    } finally {
      fs.closeSync(fd);
    }
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function emptyIndex(root, opts) {
  return { version: INDEX_VERSION, root, builtAt: 0, opts: { size: opts.size, overlap: opts.overlap, minSize: opts.minSize }, files: {}, df: {}, avgLen: 1, chunks: [] };
}

function readIndexFile() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch {
    return null;
  }
}

let cache = { at: 0, index: null };

/** 加载索引（进程内缓存；文件被重建后按 mtime 失效） */
export function loadIndex() {
  let st;
  try {
    st = fs.statSync(INDEX_FILE);
  } catch {
    cache = { at: 0, index: null };
    return null;
  }
  if (cache.index && cache.at === st.mtimeMs) return cache.index;
  const index = readIndexFile();
  if (!index || index.version !== INDEX_VERSION) return null;
  cache = { at: st.mtimeMs, index };
  return index;
}

/**
 * 建索引。同步执行（本机知识库规模下 1–3 秒，不做花哨的进度流）。
 * @param {{cfg:object, root?:string, rebuild?:boolean}} o
 */
export function buildIndex({ cfg, root, rebuild = false } = {}) {
  const t0 = Date.now();
  const opts = ragOptions(cfg);
  const absRoot = path.resolve(root || resolveRagRoot(cfg));
  let st;
  try {
    st = fs.statSync(absRoot);
  } catch {
    throw new Error(`知识库目录不存在：${absRoot}`);
  }
  if (!st.isDirectory()) throw new Error(`知识库路径不是目录：${absRoot}`);

  const prev = rebuild ? null : readIndexFile();
  const sameShape =
    prev && prev.version === INDEX_VERSION && prev.root === absRoot &&
    prev.opts?.size === opts.size && prev.opts?.overlap === opts.overlap && prev.opts?.minSize === opts.minSize;
  const byFile = new Map();
  if (sameShape) {
    for (const c of prev.chunks || []) {
      if (!byFile.has(c.file)) byFile.set(c.file, []);
      byFile.get(c.file).push(c);
    }
  }

  const { files, dirs } = walkFiles(absRoot, opts);
  const chunks = [];
  const fileMeta = {};
  let reusedChunks = 0;
  let skippedBinary = 0;
  let truncated = false;

  for (const rel of files) {
    if (chunks.length >= opts.maxChunks) {
      truncated = true;
      break;
    }
    const abs = path.join(absRoot, rel);
    let fsStat;
    try {
      fsStat = fs.statSync(abs);
    } catch {
      continue;
    }
    const mtime = Math.round(fsStat.mtimeMs);
    const old = sameShape ? prev.files?.[rel] : null;
    if (old && old.size === fsStat.size && old.mtime === mtime && byFile.has(rel)) {
      const oldChunks = byFile.get(rel);
      for (const c of oldChunks) chunks.push(c);
      fileMeta[rel] = { size: fsStat.size, mtime, chunks: oldChunks.length };
      reusedChunks += oldChunks.length;
      continue;
    }
    const text = readTextFile(abs, opts.maxFileBytes);
    fileMeta[rel] = { size: fsStat.size, mtime, chunks: 0 };
    if (!text) {
      skippedBinary += 1;
      continue;
    }
    const pieces = chunkText(text, opts);
    let n = 0;
    for (const p of pieces) {
      if (chunks.length >= opts.maxChunks) {
        truncated = true;
        break;
      }
      const body = p.heading ? `# ${p.heading}\n${p.text}` : p.text;
      const toks = tokenize(body);
      const tf = Object.create(null);
      for (const t of toks) tf[t] = (tf[t] || 0) + 1;
      chunks.push({
        id: `${rel}#${n}`,
        file: rel,
        heading: p.heading,
        startLine: p.startLine,
        endLine: p.endLine,
        text: p.text,
        len: toks.length,
        tf,
      });
      n += 1;
    }
    fileMeta[rel].chunks = n;
  }

  const df = Object.create(null);
  let totalLen = 0;
  for (const c of chunks) {
    totalLen += c.len;
    for (const term of Object.keys(c.tf)) df[term] = (df[term] || 0) + 1;
  }
  const index = {
    version: INDEX_VERSION,
    root: absRoot,
    builtAt: Date.now(),
    opts: { size: opts.size, overlap: opts.overlap, minSize: opts.minSize },
    files: fileMeta,
    df,
    avgLen: chunks.length ? totalLen / chunks.length : 1,
    chunks,
  };

  fs.mkdirSync(RAG_DIR, { recursive: true });
  const tmp = INDEX_FILE + '.tmp';
  const json = JSON.stringify(index);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, INDEX_FILE);

  const meta = {
    version: INDEX_VERSION,
    root: absRoot,
    builtAt: index.builtAt,
    ms: Date.now() - t0,
    dirs,
    files: Object.keys(fileMeta).length,
    chunks: chunks.length,
    tokens: totalLen,
    indexBytes: Buffer.byteLength(json),
    reusedChunks,
    skipped: skippedBinary,
    truncated,
    opts: index.opts,
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
  cache = { at: 0, index: null };
  return meta;
}

/** 状态（只读 meta.json，不解析大索引） */
export function indexStatus() {
  const meta = readMeta();
  if (!meta) return { exists: false, dir: RAG_DIR };
  return { exists: true, dir: RAG_DIR, ...meta };
}
