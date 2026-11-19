import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { CloudError } from './errors.js';

export function safeHeaders(input: IncomingMessage['headers'], websocket = false) {
  const allowed = new Set(['content-type', 'content-length', 'accept', 'x-lang', 'cache-control', 'if-none-match', 'range']);
  if (websocket) for (const k of ['upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) allowed.add(k);
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined));
}
export function responseHeaders(input: IncomingMessage['headers']) {
  const allowed = new Set(['content-type','content-length','content-disposition','content-range','accept-ranges','etag']);
  return { ...Object.fromEntries(Object.entries(input).filter(([key]) => allowed.has(key))), 'cache-control': 'no-store' };
}
export function fail(res: ServerResponse, error: unknown) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(error instanceof CloudError ? error.status : 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: error instanceof CloudError ? error.message : '设备连接中断，请先检查任务状态再重试。' }));
}

export function proxyHttp(req: IncomingMessage, res: ServerResponse, route: string, stream: Duplex,
  extraHeaders: Record<string,string> = {}) {
  const upstream = http.request({ method: req.method, path: route, host: 'localhost',
    headers: { ...safeHeaders(req.headers), host: 'localhost', connection: 'close', ...extraHeaders },
    createConnection: () => stream as any,
  });
  const timer = setTimeout(() => { upstream.destroy(); fail(res, new CloudError(504, '操作超时，请先检查任务列表再重试。')); }, 180_000);
  timer.unref();
  const clean = () => { clearTimeout(timer); stream.destroy(); };
  upstream.on('error', error => { fail(res, error); clean(); });
  upstream.on('response', response => {
    res.writeHead(response.statusCode || 502, responseHeaders(response.headers));
    response.on('error', () => { res.destroy(); clean(); });
    response.pipe(res);
  });
  res.on('close', () => { upstream.destroy(); clean(); });
  req.on('aborted', () => { upstream.destroy(); clean(); });
  req.pipe(upstream);
}

export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, route: string, stream: Duplex) {
  const upstream = http.request({ method: 'GET', path: route, host: 'localhost',
    headers: { ...safeHeaders(req.headers, true), host: 'localhost', connection: 'Upgrade' },
    createConnection: () => stream as any });
  const timer = setTimeout(() => { upstream.destroy(); stream.destroy(); socket.destroy(); }, 15_000);
  timer.unref();
  const close = () => { clearTimeout(timer); stream.destroy(); socket.destroy(); upstream.destroy(); };
  upstream.on('error', close); socket.on('error', close); socket.on('close', close);
  upstream.on('response', close);
  upstream.on('upgrade', (response, tunnel, initial) => {
    clearTimeout(timer);
    const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
    for (let i=0;i<response.rawHeaders.length;i+=2) {
      if (/^(upgrade|connection|sec-websocket-accept|sec-websocket-protocol|sec-websocket-extensions)$/i.test(response.rawHeaders[i])) {
        lines.push(response.rawHeaders[i] + ': ' + response.rawHeaders[i+1]);
      }
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (initial.length) socket.write(initial);
    if (head.length) tunnel.write(head);
    tunnel.on('error', close); tunnel.on('close', close);
    tunnel.pipe(socket); socket.pipe(tunnel);
  });
  upstream.end();
}
