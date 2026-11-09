/**
 * SSE 事件总线：所有 run 的事件都从这里广播给浏览器。
 * 页面刷新/重连不会中断正在跑的 run（run 在服务端内存里继续）。
 */
const clients = new Set();
let seq = 0;

export function addClient(res) {
  const client = { res, id: ++seq };
  clients.add(client);
  res.write(': connected\n\n');
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);
  ping.unref?.();
  const drop = () => {
    clearInterval(ping);
    clients.delete(client);
  };
  res.on('close', drop);
  res.on('error', drop);
  return () => drop();
}

export function emitEvent(ev) {
  if (!clients.size) return;
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(line);
    } catch {
      clients.delete(c);
    }
  }
}

export function clientCount() {
  return clients.size;
}
