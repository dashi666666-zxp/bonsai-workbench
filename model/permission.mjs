import path from 'node:path';

export const PRESETS = ['read-only', 'workspace-write', 'full-access'];

export const RISK = {
  list_dir: 'read',
  read_file: 'read',
  search_files: 'read',
  web_fetch: 'net',
  web_search: 'net',
  write_file: 'write',
  edit_file: 'write',
  run_command: 'exec',
  // 多智能体：子体继承父体同样的权限档，所以派出本身不算提权
  spawn_agent: 'agent',
  message_agent: 'agent',
  agent_status: 'read',
  // 技能：只读本地 SKILL.md
  skill: 'read',
  // RAG：检索只读；建索引会扫描目录并写索引文件，按 exec 管
  rag_search: 'read',
  rag_index: 'exec',
  // 记忆：写本地记忆文件（workspace-write 档下按 path 判，目标不在工作区内会被拦）
  memory: 'write',
};

/**
 * 按工具名判风险。
 * MCP 工具（mcp__server__tool）与插件工具（plugin__name__tool）一律算 exec：
 * 前者由外部进程执行、后者是本地进程内代码，都不该在只读档里悄悄跑。
 */
export function riskOf(name) {
  const n = String(name);
  if (RISK[n]) return RISK[n];
  if (n.startsWith('mcp__')) return 'exec';
  if (n.startsWith('plugin__')) return 'exec';
  return null;
}

/** 解析相对工作区的路径，并判断是否落在工作区内 */
export function resolvePath(p, workspace) {
  const raw = String(p == null || p === '' ? '.' : p);
  const abs = path.resolve(workspace, raw);
  const rel = path.relative(workspace, abs);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return { abs, inside };
}

/**
 * 工具权限裁决。
 * @returns {{allow:boolean, reason:string, needsApproval:boolean}}
 */
export function checkPermission(name, args, cfg) {
  const preset = cfg.permission || 'workspace-write';
  const risk = riskOf(name);
  const ws = cfg.workspace;

  if (!risk) return { allow: false, reason: `未知工具 ${name}`, needsApproval: false };

  // 派出/调度子体不改变钳制范围，任何档位都允许（子体自己再受同一套权限约束）
  if (risk === 'agent') return { allow: true, reason: '', needsApproval: false };

  if (preset === 'read-only') {
    if (risk === 'read' || risk === 'net') return { allow: true, reason: '', needsApproval: false };
    return { allow: false, reason: `当前为只读档，禁止${risk === 'write' ? '写文件' : '执行命令'}。如需修改请在设置里切换权限档。`, needsApproval: false };
  }

  if (preset === 'full-access') {
    return { allow: true, reason: '', needsApproval: false };
  }

  // workspace-write（默认）
  if (risk === 'read' || risk === 'net') return { allow: true, reason: '', needsApproval: false };

  if (risk === 'write') {
    const target = args?.path;
    const { inside } = resolvePath(target, ws);
    if (!inside) {
      return { allow: false, reason: `路径越界：${target} 不在工作区 ${ws} 内。切到 full-access 才能写外部路径。`, needsApproval: false };
    }
    return { allow: true, reason: '', needsApproval: false };
  }

  // exec
  const cwd = args?.cwd ? resolvePath(args.cwd, ws) : { inside: true };
  if (!cwd.inside) {
    return { allow: false, reason: `cwd 越界：${args.cwd} 不在工作区内`, needsApproval: false };
  }
  return { allow: true, reason: '', needsApproval: cfg.approval === 'ask' };
}
