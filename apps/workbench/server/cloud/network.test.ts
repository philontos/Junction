import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { once } from 'node:events';
import { cloudSocketOptions, configureCloudNetwork } from './network.js';

test('an unavailable configured interface fails only Junction requests; other fetches retain their route', async t => {
  const listen = async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return 'http://127.0.0.1:' + (server.address() as any).port;
  };
  const cloud = await listen(), other = await listen();
  assert.deepEqual(cloudSocketOptions(), {});
  assert.throws(() => cloudSocketOptions('junction-no-such-interface'), { code: 'EADDRNOTAVAIL' });
  const reset = configureCloudNetwork(cloud, 'junction-no-such-interface');
  try {
    assert.equal(await (await fetch(other)).text(), 'ok');
    await assert.rejects(fetch(cloud), (error: any) => error.cause?.code === 'EADDRNOTAVAIL');
  } finally { await reset(); }
  assert.equal(await (await fetch(cloud)).text(), 'ok');
  const loopback = Object.entries(os.networkInterfaces()).find(([, addresses]) => addresses?.some(a => a.family === 'IPv4' && a.address === '127.0.0.1'))?.[0];
  assert.ok(loopback);
  const restore = configureCloudNetwork(cloud, loopback);
  try { assert.equal(await (await fetch(cloud)).text(), 'ok'); }
  finally { await restore(); }
});
