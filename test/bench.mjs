/**
 * 生成速度基准（对已运行的 llama-server 打，不负责启停）。
 *
 * 为什么要有它：`--spec-type ngram-mod` 这类投机解码只在「生成的文本在缓存里」时才爆发，
 * 用同一个 prompt 连打两三次会看到 +200%~+690% 的假象。本工具把「首轮（冷）」与
 * 「重复轮」分开报，并在重复轮明显高于首轮时打警告。
 *
 * 用法：
 *   node test/bench.mjs                       # 默认 http://127.0.0.1:8082，每 prompt 3 轮
 *   node test/bench.mjs --port 8082 --reps 3
 *   node test/bench.mjs --json out.json
 *
 * 读法：
 *   pp1 = 首轮 prompt processing（prefill）速度，tok/s；长会话里每步只处理增量，pp 只影响首次
 *   tg1 = 首轮 decode 速度，tok/s —— 这才是「每秒 token 数」，受显存带宽限制
 *   tg2/tg3 高很多 = 缓存命中，不代表参数有效
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(arg('--port', process.env.BW_LLAMA_PORT || 8082));
const REPS = Math.max(1, Number(arg('--reps', 3)));
const JSON_OUT = arg('--json', '');
const BASE = `http://127.0.0.1:${PORT}`;

const FILLER =
  '内存层次结构从寄存器、L1/L2/L3 缓存、主存到磁盘，逐级容量增大而延迟升高。' +
  '现代 CPU 通过预取、乱序执行与缓存一致性协议隐藏访存延迟；GPU 则用大量线程与高带宽显存换吞吐。' +
  '当工作集超过缓存容量时，性能会出现断崖式下降，这就是所谓的内存墙问题。';

const PROMPTS = [
  { id: 'chat', maxTokens: 120, text: '用三句话解释什么是虚拟内存。' },
  { id: 'code', maxTokens: 220, text: '用 Node.js 写一个函数，把一个目录下所有 .md 文件按大小降序返回，不要解释。' },
  { id: 'summary', maxTokens: 180, text: `把下面的内容压成 3 条要点：\n${FILLER.repeat(4)}` },
  { id: 'long', maxTokens: 140, text: `请用一句话概括下面这段长文的主旨：\n${(FILLER + '\n').repeat(40)}` },
];

async function models() {
  const r = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return (j.data || []).map((m) => m.id);
}

async function one(model, p) {
  const body = {
    model,
    messages: [{ role: 'user', content: p.text }],
    stream: false,
    max_tokens: p.maxTokens,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
  };
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const t = j.timings || {};
  return {
    pp: Number(t.prompt_per_second) || 0,
    promptN: Number(t.prompt_n) || 0,
    tg: Number(t.predicted_per_second) || 0,
    outN: Number(t.predicted_n) || 0,
    draftN: Number(t.draft_n) || 0,
    draftOk: Number(t.draft_n_accepted) || 0,
    wallMs: Date.now() - t0,
  };
}

const f = (x) => x.toFixed(1).padStart(6);

async function main() {
  let list;
  try {
    list = await models();
  } catch (e) {
    console.error(`连不上 ${BASE}：${e.message}\n先把工作台/llama-server 起来（双击「Bonsai 工作台」）。`);
    process.exit(2);
  }
  const model = list[0];
  console.log(`endpoint ${BASE}  model ${model}  reps ${REPS}\n`);
  console.log('prompt      pp1   tg1    tg2    tg3    drafts  出token  备注');
  const rows = [];
  for (const p of PROMPTS) {
    const runs = [];
    for (let i = 0; i < REPS; i++) runs.push(await one(model, p));
    const tg = runs.map((r) => r.tg);
    const warmHit = tg.slice(1).some((x) => x > tg[0] * 1.2);
    const note = warmHit ? '重复轮明显更快=缓存命中，非参数收益' : '';
    console.log(
      `${p.id.padEnd(10)} ${f(runs[0].pp)} ${f(tg[0])} ${tg[1] != null ? f(tg[1]) : '     -'} ${
        tg[2] != null ? f(tg[2]) : '     -'
      }   ${String(runs[0].draftN).padStart(5)}  ${String(runs[0].outN).padStart(6)}  ${note}`,
    );
    rows.push({ id: p.id, runs, warmHit });
  }
  const cold = rows.map((r) => r.runs[0].tg).filter((x) => x > 0);
  const avg = cold.reduce((a, b) => a + b, 0) / Math.max(1, cold.length);
  console.log(`\n首轮平均 decode ${avg.toFixed(1)} tok/s（同批连跑才可比；跨时段基线会漂 20%+）`);
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), endpoint: BASE, model, rows }, null, 2));
    console.log(`已写 ${JSON_OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
