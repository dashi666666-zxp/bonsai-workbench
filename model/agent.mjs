import { chatStream, modelCaps, ctxSize } from './llm.mjs';
import { allTools, toolSchema, toolNames, execTool } from './tools.mjs';
import { checkPermission } from './permission.mjs';
import { extractToolCalls, fuzzyToolName, normalizeNativeCalls } from './parser.mjs';
import { skillsCatalogBlock } from './skills.mjs';
import { retrieve, verifyAnswer } from './rag.mjs';
import { compressSession, summaryBlock } from './compress.mjs';
import { thinkingOptions, buildThinkingBlock, planRequest, parsePlan, fallbackPlan, checkAnswerPath } from './thinking.mjs';
import { injectionBlock, memoryEmptyHint } from './memory.mjs';

/**
 * Bonsai 线的 agent 主循环。
 *
 * 与 Ollama 线的差别：
 *   - 只有一个后端：`model/llm.mjs`（OpenAI 兼容 /v1：本机 llama.cpp 或 LLMpod 网关）。
 *   - 不判断「嵌入模型/think 能力」：这条线只接 chat 模型，thinking 开关永远显式下发
 *     （llama.cpp 的 jinja 模板不传 enable_thinking 时默认开思考，27B 会一路想到上下文用尽）。
 *   - 不做本机硬件档位（num_gpu/num_ctx 由 llama-server 启动参数决定，工作台只读 /props）。
 */

const PERM_LABEL = {
  'read-only': '只读（禁止写文件与执行命令）',
  'workspace-write': '工作区写（只能改工作区内的文件，命令在工作区内执行）',
  'full-access': '完全访问（可读写任意路径、可执行命令）',
};

function groupTools(tools) {
  const builtin = [];
  const mcp = [];
  const plugin = [];
  const agent = [];
  for (const t of tools) {
    const n = String(t.name);
    if (t.source === 'mcp' || n.startsWith('mcp__')) mcp.push(t);
    else if (t.source === 'plugin' || n.startsWith('plugin__')) plugin.push(t);
    else if (t.risk === 'agent' || t.name === 'agent_status') agent.push(t);
    else builtin.push(t);
  }
  return { builtin, mcp, plugin, agent };
}

export function buildSystemPrompt(cfg, tools, extra = '') {
  const list = tools || allTools(cfg);
  const { builtin, mcp, plugin, agent } = groupTools(list);
  const lines = [
    '你是运行在本地 llama.cpp 端点上的 Bonsai 工作台 agent。',
    `工作区：${cfg.workspace}`,
    `权限档：${PERM_LABEL[cfg.permission] || cfg.permission}`,
    '',
    '规则：',
    '1. 需要读文件、搜代码、执行命令、访问网页、改文件或调用外部工具时，调用工具；不需要就直接回答。',
    '2. 只能使用下面列出的工具。不存在的工具不要发明，编造工具名会浪费一轮。',
    '3. 可以一次调用一个或多个工具；拿到结果后继续推理，直到任务完成。',
    '4. 工具返回以 "err:" 开头表示失败。读错误信息再调整，不要重复同样的失败调用。',
    '5. 简单任务不要凑步数；能一次做完就一次做完。',
    '6. 任务完成后，直接用中文给出简洁的最终答复。最终答复里不要包含工具调用 JSON。用户明确要求「直接输出 / 给我完整代码 / 完整文件内容」时，把完整内容直接写进答复正文（代码块），不要改用 write_file 落盘；只有用户要求「保存成文件 / 写进某个路径」时才用 write_file。',
  ];

  if (agent.length) {
    lines.push(
      '7. 遇到可以并行的独立子任务（分别调查多个方向、分别改多个文件），用 spawn_agent 派子体并行做；子体有独立上下文，不会污染你的对话。',
      '8. 派出后不要自己重复同一件事；用 agent_status 查进度（完成时 final 里有它的答复），用 message_agent 追加要求。子体继承同样的工作区与权限档。'
    );
  }
  if (mcp.length) {
    lines.push('9. 名字以 mcp__ 开头的是外部 MCP 服务器提供的工具（mcp__服务器__工具名），调用方式与其它工具相同。');
  }
  if (plugin.length) {
    lines.push('10. 名字以 plugin__ 开头的是本地插件提供的工具（plugin__插件__工具名），调用方式与其它工具相同。');
  }
  if (builtin.some((t) => t.name === 'web_search')) {
    lines.push('11. 需要最新/实时信息（新闻、版本、文档现状）时先用 web_search 搜，再用 web_fetch 抓具体链接；不要凭记忆编造事实。');
  }
  const hasSkill = list.some((t) => t.source === 'skill');
  if (hasSkill) {
    lines.push('12. 要按某个技能的步骤办事时，先 skill(名字) 把它的操作手册读进来再动手；手册没读之前不要自己编流程。');
  }
  if (list.some((t) => t.source === 'memory')) {
    lines.push(
      '13. 跨会话记忆已分层：长期偏好存 memory(target="user")，全局环境事实存 target="memory"，本项目关键结论存 target="key"（这三层下一轮会自动注入）；过程进展存 target="project"。先看已注入的记忆，别重复问已知信息；只记长期有用的事实，一次性细节不写。',
    );
  }

  lines.push('', '可用工具：', ...builtin.map((t) => `- ${t.hint}`));
  if (mcp.length) lines.push('', 'MCP 工具：', ...mcp.map((t) => `- ${t.hint}`));
  if (plugin.length) lines.push('', '插件工具：', ...plugin.map((t) => `- ${t.hint}`));
  if (agent.length) lines.push('', '子智能体工具：', ...agent.map((t) => `- ${t.hint}`));
  if (hasSkill) {
    const cat = skillsCatalogBlock(cfg);
    if (cat.count) lines.push('', cat.text);
  }
  if (extra) lines.push('', extra);
  return lines.join('\n');
}

/** 把会话消息转成 OpenAI /v1/chat/completions 的消息（llama.cpp 客户端再做最终映射） */
function toLLMMessages(session, cfg) {
  const msgs = [];
  // 已被摘要覆盖的旧消息不再全量发送（原始记录仍留在 session.messages 里）
  const start = Math.max(0, Math.min(Number(session.summaryUpTo) || 0, session.messages.length));
  for (const m of session.messages.slice(start)) {
    if (m.role === 'user') {
      const out = { role: 'user', content: String(m.content || '') };
      // 图片（data URL 数组）只在有视觉能力的后端有意义，llama.cpp 客户端再转 content 数组
      if (Array.isArray(m.images) && m.images.length) out.images = m.images;
      msgs.push(out);
    } else if (m.role === 'assistant') {
      const out = { role: 'assistant', content: String(m.content || '') };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length && !m.fromText) {
        out.tool_calls = m.tool_calls;
      }
      if (out.content || out.tool_calls) msgs.push(out);
    } else if (m.role === 'tool') {
      msgs.push({ role: 'tool', tool_name: m.tool_name || 'unknown', content: String(m.content || '') });
    }
  }
  return compactHistory(msgs, cfg);
}

/** Token saver：历史太长时把旧工具输出压成一行占位 */
function compactHistory(msgs, cfg) {
  const budget = Number(cfg.tokenSaver?.historyBudgetChars) || 48000;
  let total = msgs.reduce((n, m) => n + (m.content || '').length, 0);
  if (total <= budget) return msgs;

  const keepTail = 6;
  const limit = msgs.length - keepTail;
  for (let i = 0; i < limit && total > budget; i++) {
    const m = msgs[i];
    if (m.role !== 'tool' || !m.content) continue;
    const before = m.content.length;
    if (before <= 200) continue;
    m.content = `[旧的工具输出已省略 ${before} 字符以节省上下文]`;
    total -= before - m.content.length;
  }
  return msgs;
}

/** Token saver：单个工具输出截断（保头保尾） */
export function applyTokenSaver(text, cfg) {
  const s = String(text ?? '');
  const maxChars = Number(cfg.tokenSaver?.toolOutputMaxChars) || 8000;
  const maxLines = Number(cfg.tokenSaver?.toolOutputMaxLines) || 200;

  let out = s;
  let truncated = false;

  const lines = out.split('\n');
  if (lines.length > maxLines) {
    const head = Math.ceil(maxLines * 0.7);
    const tail = Math.max(0, maxLines - head - 1);
    const tailLines = tail > 0 ? lines.slice(-tail) : [];
    out = [...lines.slice(0, head), `... 省略 ${lines.length - head - tailLines.length} 行 ...`, ...tailLines].join('\n');
    truncated = true;
  }
  if (out.length > maxChars) {
    const head = Math.ceil(maxChars * 0.7);
    const tail = Math.max(0, maxChars - head - 40);
    const tailText = tail > 0 ? out.slice(-tail) : '';
    out = out.slice(0, head) + `\n... 省略 ${out.length - head - tailText.length} 字符 ...\n` + tailText;
    truncated = true;
  }
  return { text: out, truncated };
}

function argsOf(call) {
  if (call.args && typeof call.args === 'object') return call.args;
  if (typeof call.argsStr === 'string' && call.argsStr.trim()) {
    try {
      const v = JSON.parse(call.argsStr);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** 从流的增量里回收 tool_calls（llama.cpp 分片发，index 在 tool_call 顶层） */
function mergeStreamedCalls(map, toolCalls) {
  for (const [i, tc] of toolCalls.entries()) {
    const fn = tc?.function || {};
    const idx = Number.isInteger(tc?.index) ? tc.index : Number.isInteger(fn.index) ? fn.index : i;
    const prev = map.get(idx) || { id: tc?.id || `call_${idx}`, name: '', argsStr: '', args: null };
    if (tc?.id) prev.id = tc.id;
    if (fn.name) prev.name = fn.name;
    if (typeof fn.arguments === 'string') prev.argsStr += fn.arguments;
    else if (fn.arguments && typeof fn.arguments === 'object') prev.args = fn.arguments;
    map.set(idx, prev);
  }
}

/** 最近一条真正的用户输入（压缩/检索的查询来源） */
function lastUserText(session) {
  const msgs = session.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.role !== 'user' || m.steer) continue;
    const t = String(m.content || '').trim();
    if (t.length >= 2) return t;
  }
  return '';
}

/**
 * Agent 主循环。
 * @param {object} o
 * @param {object} o.session  会话对象（会被就地修改）
 * @param {object} o.cfg      运行时配置（model/think/permission/workspace/...）
 * @param {(ev:object)=>void} o.emit
 * @param {AbortSignal} o.signal
 * @param {(callId:string)=>Promise<boolean>} o.requestApproval
 * @param {object} [o.agents] 子智能体运行时（spawn/message/status）
 * @param {() => string|null} [o.takeSteer] 每步开始时取一条人工/父体追加的要求
 * @returns {Promise<{status:'done'|'stopped'|'error', error?:string}>}
 */
export async function runAgent({ session, cfg, emit, signal, requestApproval, agents, takeSteer }) {
  const tools = allTools(cfg);
  const names = toolNames(tools);
  const model = session.model || cfg.model;
  if (!model) return { status: 'error', error: '没有选择模型' };

  const caps = await modelCaps(model);
  const nativeTools = caps.caps.includes('tools');

  emit({
    type: 'agent_mode',
    nativeTools,
    caps: caps.caps,
    model,
    contextLength: caps.contextLength || 0,
  });

  let corrections = 0;
  let verifyRetries = 0;
  let lastSig = '';
  let repeatCount = 0;

  // 检索预算：27B 在「资料里没有答案」时会换着措辞反复 rag_search（实测一轮 12 次、
  // 还把索引 root 改到工作区），既烧时间又把上下文推到溢出。给每次 run 一个硬预算，
  // 用尽后直接让模型按「资料不足」回答——这比让它无限找更能压幻觉。
  const RAG_SEARCH_BUDGET = 4;
  const RAG_INDEX_BUDGET = 1;
  let ragSearches = 0;
  let ragIndexes = 0;

  // ---- 开跑前：先压缩历史（释放上下文），再按最近一条用户输入检索知识库 ----
  // 压缩阈值与 chat 裁剪共用端点真实 n_ctx（/props）：外部端点下 -c 写在别人的启动脚本里，
  // 只看本程序 extraArgs 会按 8192 误判，长会话很早触发一次无谓的 27B 摘要调用。
  const serverCtx = await ctxSize().catch(() => 0);
  if (cfg.ctx?.enabled !== false) {
    try {
      const c = await compressSession({ session, cfg, emit, signal, ctxLimit: serverCtx });
      if (c?.error) emit({ type: 'ctx_info', text: c.error });
    } catch (e) {
      emit({ type: 'ctx_info', text: `上下文压缩失败（继续跑）：${e?.message || e}` });
    }
    if (signal.aborted) return { status: 'stopped' };
  }

  let rag = null;
  const ragQuery = lastUserText(session);
  if (cfg.rag?.enabled !== false && cfg.rag?.autoRetrieve !== false && ragQuery) {
    try {
      rag = retrieve({ cfg, query: ragQuery });
      if (rag.ok) {
        emit({
          type: 'rag_retrieved',
          query: ragQuery,
          sources: rag.sources,
          matched: rag.matched,
          chunks: rag.chunks.length,
          chars: rag.chars,
          tookMs: rag.tookMs,
        });
      } else {
        emit({ type: 'rag_miss', query: ragQuery, reason: rag.reason });
        rag = null;
      }
    } catch (e) {
      rag = null;
      emit({ type: 'rag_miss', query: ragQuery, reason: `检索失败：${e?.message || e}` });
    }
  }
  // ---- 思考路径阶段 1/4：计划（PSV 的 P）----
  // 阶段由代码掌控（12-Factor Agents #8），不指望模型自觉：开跑前单独一次小调用出计划，
  // 超时/报错/输出不可解析就退回确定性计划，保证「计划阶段」永远存在。
  const thinkCfg = thinkingOptions(cfg);
  let plan = null;
  if (thinkCfg.enabled) {
    const t0 = Date.now();
    emit({ type: 'thinking_stage', stage: 'plan', status: 'start' });
    let raw = '';
    try {
      const body = {
        model,
        messages: [
          { role: 'system', content: '你是任务规划器。只输出编号计划，每行一步，不要解释、不要作答、不要调用工具。' },
          { role: 'user', content: planRequest({ task: ragQuery, sources: rag?.sources }) },
        ],
        stream: true,
        max_tokens: thinkCfg.planMaxTokens,
        options: { temperature: 0.2 },
        think: false,
      };
      const planSignal =
        typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.any([signal, AbortSignal.timeout(thinkCfg.planTimeoutMs)])
          : signal;
      for await (const chunk of chatStream(body, planSignal)) {
        const c = chunk?.message?.content;
        if (c) raw += c;
      }
      const steps = parsePlan(raw, thinkCfg.maxPlanSteps);
      if (steps.length) plan = { steps, source: 'llm' };
    } catch {
      plan = null;
    }
    if (signal.aborted) return { status: 'stopped', plan };
    if (!plan) plan = fallbackPlan({ rag });
    emit({ type: 'thinking_plan', steps: plan.steps, source: plan.source, ms: Date.now() - t0 });
  }

  const memBlock = injectionBlock(cfg);
  const promptExtra = [summaryBlock(session), buildThinkingBlock(cfg, plan), rag?.block || '', memBlock, memoryEmptyHint(cfg)]
    .filter(Boolean)
    .join('\n\n');

  for (let step = 1; step <= (Number(cfg.maxSteps) || 24); step++) {
    if (signal.aborted) return { status: 'stopped' };

    // 追加要求（人工 steer / 父体指派）在步边界注入
    const steer = takeSteer ? takeSteer() : null;
    if (steer) {
      session.messages.push({ role: 'user', content: `【追加要求】${steer}`, ts: Date.now(), steer: true });
      emit({ type: 'steer_applied', text: steer });
    }

    emit({ type: 'step', n: step, max: cfg.maxSteps });

    // llama.cpp 的 jinja 模板不传 chat_template_kwargs.enable_thinking 时默认「开思考」，
    // 27B 会一路想到上下文用尽；所以永远显式下发用户开关。
    // 后端若明确报不支持 thinking（个别模板），退一步不发该字段重试一次。
    const thinkPlans = [Boolean(cfg.think), 'omit'];

    let content = '';
    let thinking = '';
    const callMap = new Map();
    let usage = null;
    let callBytes = 0;

    let streamed = false;
    for (let pi = 0; pi < thinkPlans.length && !streamed; pi++) {
      const body = {
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt(cfg, tools, promptExtra) },
          ...toLLMMessages(session, cfg),
        ],
        stream: true,
        options: { temperature: Number(cfg.temperature) },
      };
      if (thinkPlans[pi] !== 'omit') body.think = thinkPlans[pi];
      if (nativeTools) body.tools = tools.map(toolSchema);

      content = '';
      thinking = '';
      callMap.clear();
      usage = null;
      callBytes = 0;

      try {
        for await (const chunk of chatStream(body, signal)) {
          const msg = chunk.message || {};
          if (msg.thinking) {
            thinking += msg.thinking;
            emit({ type: 'delta', kind: 'thinking', text: msg.thinking });
          }
          if (msg.content) {
            content += msg.content;
            emit({ type: 'delta', kind: 'content', text: msg.content });
          }
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            mergeStreamedCalls(callMap, msg.tool_calls);
            // 模型把整份文件塞进 tool_calls.arguments 时，这一步既无 thinking 也无 content，
            // 一步能沉默很久；每涨 200 字报一次进度供步骤条显示。
            let bytes = 0;
            for (const c of callMap.values()) bytes += String(c.argsStr ?? (c.args ? JSON.stringify(c.args) : '')).length;
            if (bytes - callBytes >= 200) {
              callBytes = bytes;
              emit({ type: 'calls', bytes, names: [...callMap.values()].map((c) => c.name).filter(Boolean) });
            }
          }
          if (chunk.done) {
            usage = {
              promptEval: chunk.prompt_eval_count || 0,
              evalCount: chunk.eval_count || 0,
              evalMs: Math.round((chunk.eval_duration || 0) / 1e6),
              totalMs: Math.round((chunk.total_duration || 0) / 1e6),
            };
          }
        }
        streamed = true;
      } catch (e) {
        if (signal.aborted) return { status: 'stopped' };
        const msg = String(e?.message || e);
        if (pi === 0 && /does not support thinking/i.test(msg)) continue;
        return { status: 'error', error: `调用 llama.cpp 失败：${e?.message || e}` };
      }
    }

    if (usage) {
      const tps = usage.evalMs > 0 ? +(usage.evalCount / (usage.evalMs / 1000)).toFixed(1) : 0;
      emit({ type: 'usage', ...usage, tps });
    }

    // ---- 第一层：原生 tool_calls ----
    let calls = normalizeNativeCalls(
      [...callMap.values()].map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args ?? c.argsStr } }))
    ).map((c) => ({ ...c, rawName: c.name, matched: names.includes(c.name) }));

    // ---- 第二层：content 里的 JSON ----
    let fromText = false;
    if (!calls.length && content.trim()) {
      const ex = extractToolCalls(content, names);
      if (ex.calls.length) {
        calls = ex.calls.map((c, i) => ({
          id: `tx_${Date.now().toString(36)}_${i}`,
          name: c.name,
          rawName: c.rawName,
          args: c.args,
          matched: c.matched,
        }));
        fromText = true;
      }
    }

    emit({
      type: 'assistant_done',
      content,
      thinking,
      fromText,
      calls: calls.map((c) => ({ id: c.id, name: c.name, rawName: c.rawName, args: c.args })),
    });

    if (!calls.length) {
      // 引用校验：有资料时必须带 [S#]，编号必须真实存在；不过关只重写一次
      let verify = null;
      if (rag) {
        verify = verifyAnswer(content, rag.chunks, { citeRequired: cfg.rag?.citeRequired !== false });
        emit({
          type: 'rag_verify',
          ok: verify.ok,
          cites: verify.cites,
          invalid: verify.invalid,
          abstained: verify.abstained,
          quoteCount: verify.quoteCount,
          unverified: verify.unverified,
          reasons: verify.reasons,
          warnings: verify.warnings,
        });
        if (!verify.ok && cfg.rag?.citeRequired !== false && verifyRetries < 1) {
          verifyRetries += 1;
          session.messages.push({
            role: 'user',
            content: `【系统校验】上一次答复没有通过引用校验：${verify.reasons.join('；')}。请只依据【知识库检索资料】重写最终答复：每个结论标注 [S#]；资料不足就直接说「资料不足」并指出缺什么；不要新增资料里没有的事实。`,
          });
          continue;
        }
      }
      // 思考路径阶段 4/4：自检（PSV 的 V）。软判据，始终记事件；requireSelfCheck 才重写一次。
      const selfCheck = checkAnswerPath(content, { requireSelfCheck: thinkCfg.requireSelfCheck });
      emit({ type: 'thinking_verify', ...selfCheck });
      if (thinkCfg.requireSelfCheck && !selfCheck.ok && verifyRetries < 1) {
        verifyRetries += 1;
        session.messages.push({
          role: 'user',
          content: `【系统校验】最终答复缺少：${selfCheck.missing.join('、')}。请按「结论 / 依据 / 自检：…」的结构重写，结论先行，不要新增资料里没有的事实。`,
        });
        continue;
      }
      session.messages.push({ role: 'assistant', content, thinking });
      return {
        status: 'done',
        plan: plan ? { steps: plan.steps, source: plan.source } : null,
        thinkingVerify: selfCheck,
        rag: rag ? { sources: rag.sources, verify } : null,
      };
    }

    session.messages.push({
      role: 'assistant',
      content: content || '',
      thinking: thinking || '',
      fromText,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args },
      })),
    });

    // ---- 逐个执行 ----
    for (const call of calls) {
      if (signal.aborted) return { status: 'stopped' };

      let name = call.matched ? call.name : fuzzyToolName(call.rawName, names);
      if (!name) {
        corrections += 1;
        const hint = `err: 没有叫 "${call.rawName}" 的工具。可用工具只有：${names.join(', ')}。请从中选一个，或直接回答用户。`;
        emit({ type: 'tool_end', callId: call.id, name: call.rawName, ok: false, denied: true, ms: 0, output: hint, truncated: false });
        session.messages.push({ role: 'tool', tool_name: call.rawName, content: hint });
        if (corrections >= 3) {
          return { status: 'error', error: `模型连续 ${corrections} 次调用不存在的工具（最后一次：${call.rawName}）` };
        }
        continue;
      }

      const args = argsOf(call);

      // 重复调用护栏：连续相同工具+参数直接跳过（不执行），第三次判失败。
      // 27B 在工具报错后容易原地重试，白烧 40 s/步。
      const sig = `${name} ${JSON.stringify(args)}`;
      if (sig === lastSig) {
        repeatCount += 1;
        if (repeatCount >= 3) {
          return { status: 'error', error: `模型连续 ${repeatCount} 次用相同参数调用 ${name}，已停止（避免空转）` };
        }
        const msg = `err: 与上一步完全相同的调用（${name}），已跳过执行。请换参数/换工具，或直接回答用户。`;
        emit({ type: 'tool_end', callId: call.id, name, ok: false, denied: true, ms: 0, output: msg, truncated: false });
        session.messages.push({ role: 'tool', tool_name: name, content: msg });
        continue;
      }
      lastSig = sig;
      repeatCount = 1;

      const verdict = checkPermission(name, args, cfg);
      if (!verdict.allow) {
        const msg = `err: 权限拒绝 — ${verdict.reason}`;
        emit({ type: 'tool_end', callId: call.id, name, ok: false, denied: true, ms: 0, output: msg, truncated: false });
        session.messages.push({ role: 'tool', tool_name: name, content: msg });
        continue;
      }

      // 检索预算：用尽后不再执行，逼模型收口（说「资料不足」或直接回答）
      if (name === 'rag_search' && ragSearches >= RAG_SEARCH_BUDGET) {
        const msg = `err: 本轮检索预算已用尽（${RAG_SEARCH_BUDGET} 次）。不要再检索：请基于已拿到的资料作答并标注 [S#]；资料里没有答案就直接说「资料不足」并指出缺什么。`;
        emit({ type: 'tool_end', callId: call.id, name, ok: false, denied: true, ms: 0, output: msg, truncated: false });
        session.messages.push({ role: 'tool', tool_name: name, content: msg });
        continue;
      }
      if (name === 'rag_index' && ragIndexes >= RAG_INDEX_BUDGET) {
        const msg = `err: 本轮索引重建预算已用尽（${RAG_INDEX_BUDGET} 次）。不要再重建索引：请基于现有检索结果作答，或直接说「资料不足」。`;
        emit({ type: 'tool_end', callId: call.id, name, ok: false, denied: true, ms: 0, output: msg, truncated: false });
        session.messages.push({ role: 'tool', tool_name: name, content: msg });
        continue;
      }
      if (name === 'rag_search') ragSearches += 1;
      if (name === 'rag_index') ragIndexes += 1;
      if (verdict.needsApproval) {
        emit({ type: 'approval_request', callId: call.id, name, args });
        const ok = await requestApproval(call.id);
        if (!ok) {
          const msg = 'err: 用户拒绝执行这条命令。请换一种不执行命令的方式，或询问用户。';
          emit({ type: 'tool_end', callId: call.id, name, ok: false, denied: true, ms: 0, output: msg, truncated: false });
          session.messages.push({ role: 'tool', tool_name: name, content: msg });
          continue;
        }
      }

      emit({ type: 'tool_start', callId: call.id, name, args });
      const t0 = Date.now();
      const res = await execTool(name, args, { cfg, signal, agents, runId: session.runId });
      const ms = Date.now() - t0;
      const cut = applyTokenSaver(res.output, cfg);
      emit({
        type: 'tool_end',
        callId: call.id,
        name,
        ok: res.ok,
        denied: false,
        ms,
        output: cut.text,
        truncated: cut.truncated,
      });
      session.messages.push({ role: 'tool', tool_name: name, content: cut.text });
    }
  }

  return { status: 'error', error: `达到最大步数 ${cfg.maxSteps}，任务可能没做完` };
}
