import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { beginLocalRecovery, clearLocalRecovery, watchLocalSession } from './local-session.js';

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    async emit(type) { await Promise.all([...listeners.get(type) || []].map(listener => listener())); },
  };
}

let original, storage, stop;
const flush = () => new Promise(resolve => queueMicrotask(resolve));
beforeEach(t => {
  storage = new Map();
  original = Object.fromEntries(['window', 'document', 'sessionStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const globals = {
    window: eventTarget(), document: { ...eventTarget(), hidden: false },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async () => ({ ok: true, status: 200 }),
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100000 });
});
afterEach(() => {
  stop?.(); stop = null;
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test('returning after a local node restart recovers immediately and coalesces resume events', async t => {
  let expired = 0, calls = 0;
  stop = watchLocalSession('device', () => expired++);
  await flush();
  document.hidden = true;
  let respond;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/local/status');
    assert.ok(options.signal instanceof AbortSignal);
    calls++;
    return new Promise(resolve => { respond = resolve; });
  };
  t.mock.timers.tick(120000);
  assert.equal(calls, 0, 'a hidden page does not poll');
  document.hidden = false;
  const resumed = document.emit('visibilitychange');
  await window.emit('focus');
  await window.emit('pageshow');
  assert.equal(calls, 1, 'one check handles all resume events');
  respond({ ok: false, status: 401 });
  await resumed;
  assert.equal(expired, 1, 'no click or polling delay is required');
  t.mock.timers.tick(60000);
  await window.emit('online');
  assert.equal(calls, 1, 'navigation is issued only once');
});

test('transient network and server failures preserve a valid login and retry on return', async () => {
  let expired = 0;
  globalThis.fetch = async () => { throw new TypeError('Network unavailable'); };
  stop = watchLocalSession('device', () => expired++);
  await flush();
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await window.emit('online');
  assert.equal(expired, 0);
  assert.equal(beginLocalRecovery('device'), true);
  assert.equal(beginLocalRecovery('device'), false);
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  await window.emit('focus');
  assert.equal(expired, 0);
  assert.equal(beginLocalRecovery('device'), true, 'verified login clears a previous retry limit');
});

test('cleanup ignores a late authentication failure and removes all recovery listeners', async t => {
  let respond, expired = 0, calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise(resolve => { respond = resolve; }); };
  stop = watchLocalSession('device', () => expired++);
  stop();
  respond({ ok: false, status: 401 });
  await flush();
  await window.emit('focus');
  await document.emit('visibilitychange');
  t.mock.timers.tick(60000);
  assert.equal(expired, 0);
  assert.equal(calls, 1);
});

test('automatic sign-in is bounded per device and can resume after success or a cooldown', t => {
  assert.equal(beginLocalRecovery('a'), true);
  assert.equal(beginLocalRecovery('a'), false, 'blocked cookies must not cause a redirect loop');
  assert.equal(beginLocalRecovery('b'), true);
  t.mock.timers.tick(59999);
  assert.equal(beginLocalRecovery('a'), false);
  t.mock.timers.tick(1);
  assert.equal(beginLocalRecovery('a'), true);
  clearLocalRecovery('a');
  assert.equal(beginLocalRecovery('a'), true);
  assert.ok([...storage.values()].every(value => /^\d+$/.test(value)), 'only retry timestamps are stored');
});

test('storage restrictions leave the manual reconnection path available', () => {
  globalThis.sessionStorage = { getItem() { throw new Error('Storage denied'); } };
  assert.equal(beginLocalRecovery('device'), false);
  assert.doesNotThrow(() => clearLocalRecovery('device'));
});
