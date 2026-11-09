/**
 * 测试用的 HTTP MCP 服务器：同一端口上同时提供两种传输。
 *
 *   POST /mcp         Streamable HTTP：initialize 回 JSON + Mcp-Session-Id 头，
 *                     tools/list 与 tools/call 故意回 text/event-stream（练 SSE 解析路径）
 *   GET  /mcp         405（客户端不开订阅流，真被调用说明实现跑偏了）
 *   DELETE /mcp       结束会话（记录删除次数）
 *   GET  /sse         旧版 HTTP+SSE：先推 event:endpoint，再往这条流里推消息
 *   POST /messages    旧版回执通道：202 + 结果从 /sse 流推回
 *
 * 与 fake-mcp-server.mjs 同一套工具（echo / add），方便两种传输对照。
 */
import http from 'node:http';

const TOOLS = [
  {
    name: 'echo',
    description: '原样回显 text',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '要回显的文本' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: '两数相加',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

/** 单条 JSON-RPC 请求 → 回应对象（不含 jsonrpc / id） */
function handleRpc(msg) {
  const { method, params } = msg || {};
  if (method === 'initialize') {
    return {
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-http', version: '0.0.1' },
      },
    };
  }
  if (method === 'ping') return { result: {} };
  if (method === 'tools/list') return { result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params?.name;
    const a = params?.arguments || {};
    if (name === 'echo') {
      if (typeof a.text !== 'string') return { result: { content: [{ type: 'text', text: '缺少 text' }], isError: true } };
      return { result: { content: [{ type: 'text', text: a.text }], isError: false } };
    }
    if (name === 'add') {
      const sum = Number(a.a || 0) + Number(a.b || 0);
      return { result: { content: [{ type: 'text', text: String(sum) }], isError: false } };
    }
    return { result: { content: [{ type: 'text', text: `未知工具 ${name}` }], isError: true } };
  }
  return { error: { code: -32601, message: `method not found: ${method}` } };
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

/**
 * 起一台假服务器。返回 { url, state, close }。
 * state 里是给断言看的：requests / calls / sawSessionId / deleted / headersSeen。
 */
export async function startFakeHttpMcp() {
  const state = {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    requests: [],
    calls: [],
    sawSessionId: 0,
    deleted: 0,
    getStreamHits: 0,
    headersSeen: [],
    streams: [],
  };

  const sseHeaders = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push(`${req.method} ${url.pathname}`);

    // ---- 旧版 HTTP+SSE ----
    if (req.method === 'GET' && url.pathname === '/sse') {
      res.writeHead(200, sseHeaders);
      res.flushHeaders?.();
      state.streams.push(res);
      req.on('close', () => {
        state.streams = state.streams.filter((s) => s !== res);
      });
      // 流的第一件事：告诉客户端往哪 POST
      res.write(`event: endpoint\ndata: /messages?sessionId=${state.sessionId}\n\n`);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const raw = await readBody(req);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      state.headersSeen.push(req.headers);
      res.writeHead(202, { 'content-type': 'text/plain' }).end('Accepted');
      if (msg.id === undefined) return; // 通知不回
      const reply = { jsonrpc: '2.0', id: msg.id, ...handleRpc(msg) };
      if (msg.method === 'tools/call') state.calls.push(msg.params?.name);
      for (const stream of state.streams) {
        stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      }
      return;
    }

    // ---- Streamable HTTP ----
    if (url.pathname === '/mcp' && req.method === 'GET') {
      state.getStreamHits++;
      res.writeHead(405, { 'content-type': 'text/plain' }).end('no subscription stream');
      return;
    }
    if (url.pathname === '/mcp' && req.method === 'DELETE') {
      state.deleted++;
      res.writeHead(200, { 'content-type': 'text/plain' }).end('bye');
      return;
    }
    if (url.pathname !== '/mcp' || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    const raw = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad json');
      return;
    }
    state.headersSeen.push(req.headers);

    const isInit = msg.method === 'initialize';
    if (!isInit) {
      if (req.headers['mcp-session-id'] !== state.sessionId) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'missing or wrong mcp-session-id' } })
        );
        return;
      }
      state.sawSessionId++;
    }

    if (msg.id === undefined) {
      // 通知：202 无 body
      res.writeHead(202).end();
      return;
    }

    if (msg.method === 'tools/call') state.calls.push(msg.params?.name);
    const reply = { jsonrpc: '2.0', id: msg.id, ...handleRpc(msg) };

    if (isInit) {
      // initialize 走普通 JSON 响应，顺带下发会话 id
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': state.sessionId });
      res.end(JSON.stringify(reply));
      return;
    }

    // 其余走 SSE 响应（故意走这条分支，保证客户端真的解析了 text/event-stream）
    res.writeHead(200, sseHeaders);
    res.write(': keepalive\n\n');
    res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close() {
      for (const s of state.streams) {
        try {
          s.end();
        } catch {
          /* ignore */
        }
      }
      state.streams = [];
      server.closeAllConnections?.();
      server.close();
    },
  };
}
