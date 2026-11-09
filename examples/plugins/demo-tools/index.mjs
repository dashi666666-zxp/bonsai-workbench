/**
 * 示例插件：演示工作台插件契约。
 *
 * 契约（最小版）：
 *   export const tools = [{
 *     name,                 // 小写字母开头，[a-z0-9_]，≤48 字符；调用时全名是 plugin__<插件目录名>__<name>
 *     description,          // 给模型看的英文说明
 *     parameters,           // JSON Schema（type:'object'）
 *     risk,                 // 可选：read | write | net | exec（仅作参考；插件一律按 exec 处理）
 *     hint,                 // 可选：system prompt 里那一行（不写会自动生成）
 *     run(args, ctx)        // 必填；ctx = { cfg, signal, agents, runId }；返回 string 或 {ok,output}
 *   }]
 *   export function init({ cfg, pluginDir }) {}   // 可选，加载时调一次
 */
import crypto from 'node:crypto';

export const tools = [
  {
    name: 'now',
    description: 'Current date and time, optionally in a specific IANA time zone (e.g. Asia/Shanghai).',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA time zone, default local' },
      },
    },
    hint: 'now(timezone?) 当前时间（示例插件）',
    run(args) {
      const tz = args?.timezone ? String(args.timezone) : undefined;
      const d = new Date();
      let local = d.toLocaleString('zh-CN', tz ? { timeZone: tz } : undefined);
      return `UTC ${d.toISOString()}\n本地 ${local}${tz ? `（${tz}）` : ''}`;
    },
  },
  {
    name: 'sha256',
    description: 'Compute the sha256 hex digest of a string.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to hash' } },
      required: ['text'],
    },
    run(args) {
      const text = String(args?.text ?? '');
      return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    },
  },
];

export function init({ pluginDir }) {
  // 只打印，证明 init 被调到；真实插件可以在这里建缓存目录、读自己的配置等
  console.log(`  [plugin demo-tools] loaded from ${pluginDir}`);
}
