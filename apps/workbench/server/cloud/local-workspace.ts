import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import express from 'express';
import { proxyHttp, proxyUpgrade } from './proxy.js';
import { localEntryHtml, workspaceHtml } from './workspace.js';

import type { LocalAccessRequest, LocalAccessResult } from "../../../../packages/node-transport/local-access.js";
export type { LocalAccessRequest, LocalAccessResult } from "../../../../packages/node-transport/local-access.js";
interface Config { root: string; cloudOrigin: string; deviceId: string; deviceName: string; deviceToken: string; upstreamPort: number }
interface Session { user_id: string; username: string; expires: number }
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const validTask = (value: unknown): value is string => typeof value === 'string' && /^(?:[1-9]\d*|n[1-9]\d*:[1-9]\d*)$/.test(value);
const loopback = (address?: string) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

/** A separate, authenticated loopback listener. The existing tunnel still targets
 * the private backend; local terminal traffic never traverses the cloud. */
export function createLocalWorkspace(config: Config) {
  const origin = new URL(config.cloudOrigin).origin;
  const app = express(), server = createServer(app);
  const cookieName = 'sw_local_' + config.deviceId.replaceAll('-', '');
  const tickets = new Map<string, Session>(), sessions = new Map<string, Session>();
  const terminals = new Map<Duplex, string>();
  let owner = '', closed = false, checking: Promise<void> | undefined;
  const port = () => (server.address() as net.AddressInfo).port;
  const localOrigin = () => 'http://127.0.0.1:' + port();
  const cookie = (req: IncomingMessage) => new RegExp('(?:^|;\\s*)' + cookieName + '=([A-Za-z0-9_-]{43})(?:;|$)').exec(req.headers.cookie || '')?.[1] || '';
  const hostAllowed = (req: IncomingMessage) => loopback(req.socket.remoteAddress) && req.headers.host === '127.0.0.1:' + port();
  function session(req: IncomingMessage) {
    const entry = sessions.get(digest(cookie(req)));
    return entry && entry.expires > Date.now() && entry.user_id === owner ? entry : undefined;
  }
  function revoke() {
    tickets.clear(); sessions.clear();
    for (const socket of terminals.keys()) socket.destroy();
    terminals.clear();
  }
  function setOwner(user: string) { if (owner !== user) { revoke(); owner = user; } }
  function sweep() {
    const now = Date.now();
    for (const map of [tickets, sessions]) for (const [key, value] of map) if (value.expires <= now) map.delete(key);
    for (const [socket, key] of terminals) if (!sessions.has(key)) socket.destroy();
  }
  async function cloud(route: string) {
    const response = await fetch(origin + route, { headers: { Authorization: 'Bearer ' + config.deviceToken }, signal: AbortSignal.timeout(8000) });
    if (response.status === 401 || response.status === 403) { revoke(); owner = ''; }
    if (!response.ok) throw new Error('Cloud unavailable');
    return await response.json() as any;
  }
  async function checkIdentity() {
    if (checking || !owner || closed) return checking;
    checking = (async () => {
      try {
        const identity = await cloud('/hub/node');
        if (identity.device_id !== config.deviceId || typeof identity.user_id !== 'string') { revoke(); owner = ''; }
        else setOwner(identity.user_id);
      } catch { /* A network outage must not interrupt an existing local session. */ }
    })().finally(() => { checking = undefined; });
    return checking;
  }
  const watch = setInterval(() => { sweep(); void checkIdentity(); }, 20000); watch.unref();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
    if (!hostAllowed(req)) { res.status(403).json({ error: '仅允许从本机工作台访问。' }); return; }
    // Discovery reveals only this device's ID to its configured cloud origin.
    // It neither reads cookies nor grants a session or access to the backend.
    if (req.path === '/local/identity' && req.headers.origin === origin) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'GET') {
        res.set({ 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Private-Network': 'true' });
        res.sendStatus(204); return;
      }
      if (req.method === 'GET') { next(); return; }
      res.sendStatus(405); return;
    }
    // No cross-origin browser API or WebSocket access. Login is a top-level
    // navigation carrying a short-lived code in the fragment, never in logs.
    if (req.headers.origin && req.headers.origin !== localOrigin()) { res.status(403).json({ error: '请求来源无效。' }); return; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== localOrigin()) { res.status(403).json({ error: '请从本机工作台操作。' }); return; }
    next();
  });
  app.get('/local/identity', (req, res) => {
    if (req.headers.origin !== origin || req.query.device !== config.deviceId || typeof req.query.challenge !== 'string' || !/^[0-9a-f-]{36}$/.test(req.query.challenge)) {
      res.sendStatus(404); return;
    }
    res.json({ device_id: config.deviceId, challenge: req.query.challenge });
  });
  app.get('/local/open', (_req, res) => res.type('html').send(localEntryHtml(config.root, origin, config.deviceId, 'local')));
  app.post('/local/session', express.json({ limit: '2kb' }), (req, res) => {
    sweep();
    if (req.body?.device_id !== config.deviceId) { res.status(409).json({ error: '这里是另一台设备的节点，请回到云端选择当前电脑。' }); return; }
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const grant = tickets.get(digest(code));
    if (!grant || grant.user_id !== owner) { res.status(401).json({ error: '本机打开链接已失效，请重新打开。' }); return; }
    tickets.delete(digest(code));
    const token = secret(); sessions.set(digest(token), { ...grant, expires: Date.now() + 86400_000 });
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    res.json({ ok: true, device_id: config.deviceId });
  });
  app.use(['/api', '/local/devices', '/local/status', '/local/logout'], (req, res, next) => {
    if (!session(req)) { res.status(401).json({ error: '本机登录已过期，请重新打开本机工作台。' }); return; }
    next();
  });
  app.get('/local/status', (req, res) => res.json({ device_id: config.deviceId, user_id: session(req)!.user_id, transport: 'local' }));
  app.post('/local/logout', (req, res) => {
    const key = digest(cookie(req)); sessions.delete(key);
    for (const [socket, value] of terminals) if (value === key) socket.destroy();
    res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });
  app.get('/local/devices', async (req, res) => {
    const user = session(req)!;
    try {
      const result = await cloud('/hub/node/devices');
      if (typeof result.user_id !== 'string' || !Array.isArray(result.items)) throw new Error('Invalid device directory');
      if (result.user_id !== user.user_id) { setOwner(result.user_id); res.status(401).json({ error: '设备账号已变更，请重新登录。' }); return; }
      res.json({ items: result.items.map((d: any) => d.id === config.deviceId ? { ...d, online: true } : d) });
    } catch {
      if (!session(req)) { res.status(401).json({ error: '设备绑定已失效。' }); return; }
      res.json({ items: [{ id: config.deviceId, name: config.deviceName, online: true }], cloud_offline: true });
    }
  });
  app.use('/api', (req, res) => proxyHttp(req, res, req.originalUrl, net.connect(config.upstreamPort, '127.0.0.1')));
  app.get('/', (req, res) => {
    const user = session(req);
    if (!user) {
      const query = new URLSearchParams();
      if (validTask(req.query.task)) query.set('task', req.query.task);
      if (req.query.view === 'contexts') query.set('view', 'contexts');
      const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
      if (uuid(req.query.context) && uuid(req.query.revision)) { query.set('context', req.query.context); query.set('revision', req.query.revision); }
      res.redirect('/local/open' + (query.size ? '?' + query : '')); return;
    }
    res.type('html').send(workspaceHtml(config.root, { deviceId: config.deviceId, deviceName: config.deviceName, userId: user.user_id, cloudOrigin: origin, local: true }));
  });
  app.use('/vendor/highlight', express.static(path.dirname(createRequire(import.meta.url).resolve('@highlightjs/cdn-assets/package.json'))));
  app.use(express.static(path.join(config.root, 'web'), { index: false, dotfiles: 'deny' }));
  server.on('upgrade', (req, socket, head) => {
    if (!hostAllowed(req) || req.headers.origin !== localOrigin() || !session(req) || new URL(req.url || '/', localOrigin()).pathname !== '/pty') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    terminals.set(socket, digest(cookie(req))); socket.on('close', () => terminals.delete(socket));
    proxyUpgrade(req, socket, head, req.url!, net.connect(config.upstreamPort, '127.0.0.1'));
  });
  return {
    app, server, origin: localOrigin,
    issue(request: LocalAccessRequest): LocalAccessResult {
      sweep();
      if (!request.user_id || typeof request.user_id !== 'string' || request.user_id.length > 128 || typeof request.username !== 'string') throw new Error('Invalid identity');
      setOwner(request.user_id);
      if (tickets.size >= 64 || sessions.size >= 128) throw new Error('请关闭旧页面后重试。');
      const token = secret(); tickets.set(digest(token), { user_id: request.user_id, username: request.username, expires: Date.now() + 60000 });
      const fragment = new URLSearchParams({ code: token, device: config.deviceId });
      if (validTask(request.task_id)) fragment.set('task', request.task_id);
      return { url: localOrigin() + '/local/open#' + fragment, expires_in: 60 };
    },
    checkIdentity,
    close() { closed = true; clearInterval(watch); revoke(); server.close(); server.closeAllConnections(); },
  };
}

/** Reuse the local UI port across restarts. A collision gets a new port without
 * taking down the agent backend or another application's listener. */
export async function listenLocalWorkspace(server: ReturnType<typeof createServer>, file: string) {
  let preferred = 0;
  try { const value = Number(fs.readFileSync(file, 'utf8')); if (Number.isInteger(value) && value >= 1024 && value <= 65535) preferred = value; } catch {}
  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    const error = (e: Error) => { server.off('listening', ready); reject(e); };
    const ready = () => { server.off('error', error); resolve(); };
    server.once('error', error); server.once('listening', ready); server.listen(port, '127.0.0.1');
  });
  try { await listen(preferred); } catch (error: any) { if (!preferred || error.code !== 'EADDRINUSE') throw error; await listen(0); }
  const port = (server.address() as net.AddressInfo).port;
  fs.writeFileSync(file + '.tmp', String(port), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  return port;
}
