import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createGateway } from './gateway.js';
import { startNodeTunnel } from './node.js';
import { createLocalWorkspace, listenLocalWorkspace } from './local-workspace.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function listen(server: http.Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as any).port as number; }
async function until(condition: () => boolean) { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('Timed out'); }

test('local workbench: cloud ownership, one-use login, direct HTTP/PTY, offline work and revocation', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchyard-local-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const backend = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString(), cookie: req.headers.cookie, origin: req.headers.origin }));
  });
  const pty = new WebSocketServer({ server: backend, path: '/pty' });
  pty.on('connection', ws => ws.on('message', data => ws.send(data.toString())));
  const backendPort = await listen(backend);
  t.after(() => { for (const ws of pty.clients) ws.terminate(); pty.close(); backend.closeAllConnections(); backend.close(); });
  const probe = http.createServer(); const cloudPort = await listen(probe); await new Promise<void>(r => probe.close(() => r()));
  const cloud = 'http://127.0.0.1:' + cloudPort;
  const gateway = createGateway({ root, data: path.join(dir, 'gateway'), origin: cloud, junctionPort: 1 });
  gateway.server.listen(cloudPort, '127.0.0.1'); await once(gateway.server, 'listening'); t.after(() => gateway.close());
  const alice = gateway.store.activate(gateway.store.activation('alice', '/unused'), 'local-test-password');
  const bob = gateway.store.activate(gateway.store.activation('bob', '/unused'), 'local-test-password');
  const device = gateway.store.enroll(gateway.store.pair('alice'), 'localtest', 'Local laptop');
  const local = createLocalWorkspace({ root, cloudOrigin: cloud, deviceId: device.device_id, deviceToken: device.device_token, deviceName: 'Local laptop', upstreamPort: backendPort });
  const localPort = await listenLocalWorkspace(local.server, path.join(dir, 'local-port')); t.after(() => local.close());
  assert.equal(fs.readFileSync(path.join(dir, 'local-port'), 'utf8'), String(localPort));
  const localUrl = 'http://127.0.0.1:' + localPort;
  const tunnel = startNodeTunnel(cloud, device.device_token, backendPort, () => {}, local.issue); t.after(() => tunnel.close());
  await until(() => gateway.broker.localAvailable(device.device_id));
  const grantPath = cloud + '/hub/devices/' + device.device_id + '/local-access';
  const grant = (token = alice.token, origin = cloud) => fetch(grantPath, { method: 'POST', headers: { Cookie: 'sw_session=' + token, Origin: origin, 'Content-Type': 'application/json' }, body: '{"task_id":"n2:21"}' });
  assert.equal((await grant(bob.token)).status, 404);
  assert.equal((await grant(alice.token, 'https://evil.example')).status, 403);
  const access = await (await grant()).json() as any;
  const url = new URL(access.url); assert.equal(url.origin, localUrl); assert.equal(url.search, '');
  const fragment = new URLSearchParams(url.hash.slice(1)); assert.equal(fragment.get('task'), 'n2:21');
  const redeem = (deviceId: string = device.device_id, origin = localUrl) => fetch(localUrl + '/local/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: deviceId, code: fragment.get('code') }) });
  assert.equal((await fetch(localUrl + '/api/test')).status, 401);
  assert.equal((await redeem('wrong-device')).status, 409);
  assert.equal((await redeem(device.device_id, cloud)).status, 403);
  const login = await redeem(); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const auth = cookie.split(';')[0]; assert.equal((await redeem()).status, 401);
  const request = (route: string, body?: string) => fetch(localUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: auth, Origin: localUrl, 'Content-Type': 'application/json' }, body });
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    http.get(localUrl + '/api/test', { headers: { Cookie: auth, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(localUrl + '/api/test', { headers: { Cookie: auth, Origin: cloud } })).status, 403);
  const html = await (await request('/')).text();
  assert.match(html, /switchyard-base" content=""/); assert.match(html, /data-mode="local"/);
  assert.ok(html.includes(`id="workspace-home" class="sec workspace-home" href="${cloud}/"`));
  assert.doesNotMatch(html, /workspace-cloud-return|workspace-local-open/);
  assert.match(html, /data-page-loading/);
  const returnPath = '/workspace/' + device.device_id + '/?task=n2%3A21';
  const expiredCloud = await fetch(cloud + returnPath, { redirect: 'manual' });
  assert.equal(expiredCloud.status, 302);
  assert.equal(expiredCloud.headers.get('location'), '/?next=' + encodeURIComponent(returnPath));
  const directory = await (await request('/local/devices')).json() as any; assert.equal(directory.items[0].id, device.device_id);
  assert.deepEqual(await (await request('/api/test?value=1', '{"value":42}')).json(), { path: '/api/test?value=1', body: '{"value":42}' });
  const terminal = new WebSocket(localUrl.replace('http', 'ws') + '/pty?session=test', { headers: { Cookie: auth, Origin: localUrl } });
  t.after(() => terminal.terminate()); await once(terminal, 'open');
  const echoed = once(terminal, 'message'); terminal.send('direct'); assert.equal((await echoed)[0].toString(), 'direct');
  const foreign = new WebSocket(localUrl.replace('http', 'ws') + '/pty', { headers: { Cookie: auth, Origin: cloud } });
  foreign.on('error', () => {});
  assert.equal((await once(foreign, 'unexpected-response'))[1].statusCode, 403); foreign.terminate();
  // No tunnel is available, but neither local API nor terminal depends on it.
  tunnel.close(); await until(() => !gateway.broker.nodes.has(device.device_id));
  assert.equal((await request('/api/test')).status, 200);
  const offlineEcho = once(terminal, 'message'); terminal.send('offline'); assert.equal((await offlineEcho)[0].toString(), 'offline');
  const closed = once(terminal, 'close'); gateway.store.revoke(device.device_id, 'alice'); await local.checkIdentity(); await closed;
  assert.equal((await request('/api/test')).status, 401);
  // A new owner invalidates all sessions and outstanding codes from the old one.
  const oldGrant = local.issue({ user_id: 'alice', username: 'alice' });
  local.issue({ user_id: 'bob', username: 'bob' });
  const stale = new URLSearchParams(new URL(oldGrant.url).hash.slice(1));
  assert.equal((await fetch(localUrl + '/local/session', { method: 'POST', headers: { Origin: localUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: device.device_id, code: stale.get('code') }) })).status, 401);
});
