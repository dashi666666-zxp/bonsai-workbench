/**
 * RAG 切片器（零依赖，确定性）
 *
 * 策略（吸收 GitHub 上 chunky / rag-chunk / DocSlicer 的共同设计，但自己写最小实现）：
 *   1. 先按 Markdown 标题分节，块携带「标题路径」——检索命中后仍知道这是哪一节的上下文；
 *   2. 节内按空行切段落；超长段落再按句末标点切句，仍超预算就按字符硬切；
 *   3. 按字符预算打包成块，块间保留 overlap 字符的重叠（回退按整段/整句，避免切断语义）；
 *   4. 每块记录 startLine / endLine（1 起），检索结果可回指原文。
 *
 * 全部是纯函数，同一输入必得同一输出，便于测试与增量索引。
 */

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SENT_END_RE = /[。！？!?；;…]/;

export const DEFAULT_CHUNK = { size: 700, overlap: 120, minSize: 200 };

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

function splitSentences(text) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (SENT_END_RE.test(ch)) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function hardWrap(text, size) {
  const chars = Array.from(text);
  if (chars.length <= size) return [text];
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/** 按 # 标题分节，返回 [{ heading, path:[标题...], level, lines:[{n,text}] }] */
export function splitSections(text) {
  const lines = normalizeText(text).split('\n');
  const sections = [];
  const stack = [];
  let cur = { heading: '', path: [], level: 0, lines: [] };
  const push = () => {
    if (cur.heading || cur.lines.some((l) => l.text.trim())) sections.push(cur);
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const m = trimmed.length <= 200 ? HEADING_RE.exec(trimmed) : null;
    if (m) {
      push();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
      cur = { heading: m[2].trim(), path: stack.map((s) => s.title), level, lines: [] };
      continue;
    }
    cur.lines.push({ n: i + 1, text: raw });
  }
  push();
  return sections;
}

/** 节内 → 单元（段落/句子/硬切片），每个单元带行号范围 */
function sectionUnits(section, size) {
  const units = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const text = buf.map((l) => l.text).join('\n').trim();
    if (text) units.push({ text, startLine: buf[0].n, endLine: buf[buf.length - 1].n });
    buf = [];
  };
  for (const line of section.lines) {
    if (!line.text.trim()) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();

  const out = [];
  for (const u of units) {
    if (u.text.length <= size) {
      out.push(u);
      continue;
    }
    for (const sent of splitSentences(u.text)) {
      const pieces = sent.length > size ? hardWrap(sent, size) : [sent];
      for (const p of pieces) {
        const text = p.trim();
        if (text) out.push({ text, startLine: u.startLine, endLine: u.endLine });
      }
    }
  }
  return out;
}

/**
 * 切块。
 * @param {string} text 原文
 * @param {{size?:number, overlap?:number, minSize?:number}} [opts]
 * @returns {{heading:string, startLine:number, endLine:number, text:string}[]}
 */
export function chunkText(text, opts = {}) {
  const size = Math.max(120, Number(opts.size) || DEFAULT_CHUNK.size);
  const overlap = Math.max(0, Math.min(Number(opts.overlap ?? DEFAULT_CHUNK.overlap), Math.floor(size / 2)));
  const minSize = Math.max(0, Number(opts.minSize ?? DEFAULT_CHUNK.minSize));
  const chunks = [];

  for (const section of splitSections(text)) {
    const units = sectionUnits(section, size);
    if (!units.length) continue;
    const heading = section.path.join(' > ');
    const mine = [];
    let i = 0;
    while (i < units.length) {
      let j = i;
      let chars = 0;
      while (j < units.length) {
        const add = units[j].text.length + (j > i ? 1 : 0);
        if (j > i && chars + add > size) break;
        chars += add;
        j += 1;
      }
      if (j === i) j = i + 1;
      const picked = units.slice(i, j);
      mine.push({
        heading,
        startLine: picked[0].startLine,
        endLine: picked[picked.length - 1].endLine,
        text: picked.map((u) => u.text).join('\n'),
      });
      if (j >= units.length) break;
      // 回退若干单元凑够 overlap（至少前进一个单元，保证有进展）
      let k = j;
      let ov = 0;
      while (k > i + 1 && ov + units[k - 1].text.length + 1 <= overlap) {
        k -= 1;
        ov += units[k].text.length + 1;
      }
      i = Math.max(k, i + 1);
    }

    // 同一节的尾部碎块并入上一块，避免产生只有一两行的噪声块
    for (const c of mine) {
      const prev = chunks[chunks.length - 1];
      if (prev && prev.heading === c.heading && c.text.length < minSize && prev.text.length + c.text.length <= size * 1.5) {
        prev.text += '\n' + c.text;
        prev.endLine = c.endLine;
        continue;
      }
      chunks.push(c);
    }
  }
  return chunks;
}
