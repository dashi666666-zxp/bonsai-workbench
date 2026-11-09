#!/usr/bin/env node
/**
 * 极简 stdio MCP 服务器（测试用）：换行分隔的 JSON-RPC 2.0。
 * 暴露两个工具：echo(text)、add(a,b)。
 *
 * 手动试：
 *   printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' | node test/fake-mcp-server.mjs
 */
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: '原样回显传入的文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: '两个数相加',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.1' },
      },
    });
  }
  if (method === 'notifications/initialized') return; // 通知无需回复
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === 'echo') {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(args.text ?? '') }] } });
    }
    if (name === 'add') {
      const sum = Number(args.a || 0) + Number(args.b || 0);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(sum) }] } });
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `没有工具 ${name}` } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是合法 JSON' } });
  }
  try {
    handle(msg);
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message || e) } });
  }
});
rl.on('close', () => process.exit(0));
