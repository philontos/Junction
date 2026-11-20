import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLocalDevice } from './local-discovery.js';
import { devicePath, forgetLocalDevice } from './device-routing.js';

const home = '11111111-1111-1111-1111-111111111111';
const office = '22222222-2222-2222-2222-222222222222';
const origin = 'http://127.0.0.1:54321';
const devices = [{ id: home, online: true, local_origin: origin }, { id: office, online: true, local_origin: origin }];
function setup(t, user) {
  const fetch = globalThis.fetch, localStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  t.after(() => { forgetLocalDevice(user, home); globalThis.fetch = fetch; globalThis.localStorage = localStorage; });
}
test('existing nodes are discovered without reinstalling; a remote port collision is not a match', async t => {
  setup(t, 'alice'); let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++; const query = new URL(url).searchParams;
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    return Response.json({ device_id: home, challenge: query.get('challenge') });
  };
  assert.equal((await discoverLocalDevice('alice', devices)).local.device, home);
  assert.equal(calls, 2);
  assert.equal(devicePath(home, 'alice'), '/local/open/' + home);
  assert.equal(devicePath(office, 'alice'), '/workspace/' + office + '/');
  // Offline does not erase identity or request another installation.
  assert.equal((await discoverLocalDevice('alice', devices.map(d => ({ ...d, online: false })))).local.device, home);
  assert.equal(calls, 2);
  assert.equal((await discoverLocalDevice('alice', [])).local, null);
});
test('discovery never probes arbitrary addresses or accepts stale responses', async t => {
  setup(t, 'bob'); let calls = 0;
  globalThis.fetch = async url => { calls++; assert.ok(url.startsWith(origin)); return Response.json({ device_id: home, challenge: 'stale' }); };
  const invalid = ['https://example.com', 'http://192.168.1.1:1234', origin + '/path', 'http://user@127.0.0.1:54321'];
  const result = await discoverLocalDevice('bob', [devices[0], ...invalid.map(local_origin => ({ ...devices[1], local_origin }))]);
  assert.equal(result.local, null); assert.equal(calls, 1);
  await discoverLocalDevice('bob', [devices[0], ...invalid.map(local_origin => ({ ...devices[1], local_origin }))]);
  assert.equal(calls, 1); // failed probes are not repeated on each portal poll
});
test('a browser network denial is reported, without recording a local device', async t => {
  setup(t, 'carol');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { permissions: { query: async () => ({ state: 'denied' }) } } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await discoverLocalDevice('carol', devices), { local: null, blocked: true });
});
