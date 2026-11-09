/**
 * 子智能体运行时（可观察、可 steer）。
 *
 * 父体通过 spawn_agent / message_agent / agent_status 三个工具操作；
 * 每次子体事件都会带 agentId 前缀成 agent_* 类型，由 controller 广播给前端抽屉。
 *
 * steer 语义：追加要求落到子体的下一步边界（不打断正在流式的那一步），
 * 与任务无关的抢占会破坏工具事务，所以不做强制中断。
 */
import { runAgent } from './agent.mjs';

const FINAL_MAX = 4000;

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content) return String(m.content);
  }
  return '';
}

/**
 * @param {object} o
 * @param {object} o.cfg     父体运行配置
 * @param {(ev:object)=>void} o.emit
 * @param {string} o.runId
 * @param {Function} [o.runner] 测试可注入
 */
export function createAgentRuntime({ cfg, emit, runId, runner = runAgent }) {
  const agents = new Map();
  const maxAgents = Math.max(1, Number(cfg.maxAgents) || 4);
  let seq = 0;

  function runningCount() {
    let n = 0;
    for (const a of agents.values()) if (a.status === 'running') n++;
    return n;
  }

  function spawn({ task, name, model }) {
    const text = String(task ?? '').trim();
    if (!text) throw new Error('task 不能为空');
    if (runningCount() >= maxAgents) {
      throw new Error(`同时最多 ${maxAgents} 个子体在跑（可改配置 maxAgents）。等一个结束再派。`);
    }
    const id = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const label = String(name || '').trim() || `子体 ${++seq}`;
    const agentModel = String(model || cfg.model || '');
    const childCfg = {
      ...cfg,
      model: agentModel,
      approval: 'auto', // 子体不弹人工审批，否则父子互相等待
    };
    const session = {
      id: 'child_' + id,
      model: agentModel,
      runId,
      messages: [{ role: 'user', content: text, ts: Date.now() }],
    };
    const controller = new AbortController();
    const rec = {
      agentId: id,
      name: label,
      task: text,
      model: agentModel,
      status: 'running',
      steps: 0,
      startedAt: Date.now(),
      endedAt: 0,
      final: '',
      error: null,
      lastText: '',
      controller,
      steer: [],
      session,
    };
    agents.set(id, rec);
    emit({ type: 'agent_spawn', agentId: id, name: label, task: text, model: agentModel });

    (async () => {
      const childEmit = (ev) => {
        if (ev.type === 'agent_mode') return; // 子体的模式信息前端不用，免得变成 agent_agent_mode
        if (ev.type === 'step') rec.steps = ev.n;
        if (ev.type === 'assistant_done' && ev.content) rec.lastText = String(ev.content).slice(0, 600);
        if (ev.type === 'delta' && ev.kind === 'content') {
          rec.lastText = (rec.lastText + ev.text).slice(-600);
        }
        const type = String(ev.type).startsWith('agent_') ? ev.type : 'agent_' + ev.type;
        emit({ ...ev, type, agentId: id, name: label });
      };
      let result = { status: 'error', error: '未启动' };
      try {
        result = await runner({
          session,
          cfg: childCfg,
          emit: childEmit,
          signal: controller.signal,
          requestApproval: async () => false,
          takeSteer: () => rec.steer.shift() || null,
        });
      } catch (e) {
        result = { status: 'error', error: e?.message || String(e) };
      }
      rec.status = controller.signal.aborted ? 'stopped' : result.status;
      rec.error = result.error || null;
      rec.final = lastAssistantText(session.messages).slice(0, FINAL_MAX);
      rec.endedAt = Date.now();
      emit({
        type: 'agent_end',
        agentId: id,
        name: label,
        status: rec.status,
        error: rec.error,
        final: rec.final,
      });
    })();

    return { agentId: id, name: label, model: agentModel };
  }

  function message(agentId, text) {
    const rec = agents.get(String(agentId || ''));
    if (!rec) throw new Error(`没有 agentId=${agentId} 的子体。用 agent_status 看现有子体。`);
    const t = String(text ?? '').trim();
    if (!t) throw new Error('message 不能为空');
    if (rec.status !== 'running') {
      const tail = rec.final ? `\n它的最终答复：${rec.final.slice(0, 600)}` : '';
      throw new Error(`子体 ${rec.name} 已经结束（${rec.status}），不能再追加要求。需要新任务就再 spawn_agent。${tail}`);
    }
    rec.steer.push(t);
    emit({ type: 'agent_steer', agentId: rec.agentId, name: rec.name, text: t });
    return `已把追加要求排给 ${rec.name}，它下一步会看到。`;
  }

  function status(agentId) {
    if (agentId) {
      const rec = agents.get(String(agentId));
      if (!rec) throw new Error(`没有 agentId=${agentId} 的子体`);
      return [view(rec)];
    }
    return [...agents.values()].map(view);
  }

  function view(rec) {
    return {
      agentId: rec.agentId,
      name: rec.name,
      task: rec.task,
      model: rec.model,
      status: rec.status,
      steps: rec.steps,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      lastText: rec.lastText,
      final: rec.final,
      error: rec.error,
    };
  }

  function stopAll() {
    for (const rec of agents.values()) {
      if (rec.status === 'running') {
        try {
          rec.controller.abort();
        } catch {
          /* ignore */
        }
      }
    }
  }

  return { spawn, message, status, list: () => [...agents.values()].map(view), stopAll, count: () => agents.size };
}
