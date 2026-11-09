/**
 * 真机联调脚本：对已启动的服务跑一次完整 agent 任务，打印全部事件。
 *   node test/live.mjs "你的问题"
 * 环境变量：BW_BASE（默认 http://127.0.0.1:4790）、BW_MODEL
 */
const BASE = process.env.BW_BASE || 'http://127.0.0.1:4790';
const MODEL = process.env.BW_MODEL || 'llama/bonsai-2-27b';
const PROMPT = process.argv.slice(2).join(' ') || '列出当前目录下的文件';
const TIMEOUT = Number(process.env.BW_TIMEOUT || 240000);

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function show(ev) {
  const t = ev.type;
  if (t === 'delta') {
    process.stdout.write(ev.kind === 'thinking' ? `\x1b[90m${ev.text}\x1b[0m` : ev.text);
    return;
  }
  if (t === 'tool_start') {
    console.log(`\n  \x1b[36m▶ ${ev.name}\x1b[0m ${JSON.stringify(ev.args).slice(0, 160)}`);
    return;
  }
  if (t === 'tool_end') {
    const head = ev.output ? ev.output.split('\n').slice(0, 6).join('\n    ') : '';
    console.log(`${ev.ok ? '  \x1b[32m✓' : '  \x1b[31m✗'} ${ev.name}\x1b[0m ${ev.ms}ms\n    ${head}`);
    return;
  }
  if (t === 'usage') {
    console.log(`\n  \x1b[90m[usage] in=${ev.promptEval} out=${ev.evalCount} ${ev.tps} tok/s ${ev.totalMs}ms\x1b[0m`);
    return;
  }
  if (t === 'assistant_done') {
    if (ev.calls?.length) console.log(`\n  \x1b[90m[calls] ${ev.calls.map((c) => c.name).join(', ')}${ev.fromText ? ' (文本兜底)' : ' (原生)'}\x1b[0m`);
    return;
  }
  if (t === 'agent_mode') {
    console.log(`\x1b[90m[model] ${ev.model} caps=[${ev.caps.join(',')}] nativeTools=${ev.nativeTools}\x1b[0m`);
    return;
  }
  if (t === 'step') console.log(`\n\x1b[90m── step ${ev.n}/${ev.max} ──\x1b[0m`);
  if (t === 'run_end') console.log(`\n\x1b[90m[run_end] ${ev.status} ${ev.error || ''}\x1b[0m`);
}

const started = await api('/api/runs', {
  method: 'POST',
  body: { text: PROMPT, overrides: { model: MODEL, think: false, permission: 'workspace-write', approval: 'auto' } },
});
console.log(`run=${started.runId} session=${started.sessionId} model=${MODEL}\nprompt: ${PROMPT}\n`);

let seen = 0;
const t0 = Date.now();
for (;;) {
  const evs = await api('/api/runs/' + started.runId + '/events');
  for (; seen < evs.length; seen++) show(evs[seen]);
  const end = evs.find((e) => e.type === 'run_end');
  if (end) {
    console.log(`\n\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s  事件 ${evs.length} 条`);
    process.exit(end.status === 'done' ? 0 : 1);
  }
  if (Date.now() - t0 > TIMEOUT) {
    console.log('\n\n[TIMEOUT]');
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 300));
}
