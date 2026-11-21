import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const device = '11111111-1111-1111-1111-111111111111';
const cloud = 'https://cloud.example';
let sequence = 0, url, redirects, elements, storage, ready, originals;
const response = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const run = () => import('./local-entry.js?case=' + ++sequence);

beforeEach(() => {
  url = new URL('http://127.0.0.1:4500/local/open?task=48');
  redirects = []; elements = new Map(); storage = new Map(); ready = false;
  const meta = { 'local-entry-mode': 'local', 'switchyard-device-id': device, 'switchyard-cloud-origin': cloud };
  const globals = {
    document: {
      querySelector: selector => ({ content: meta[/name="([^"]+)"/.exec(selector)[1]] }),
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { href: cloud + '/local/open/' + device + '#theme=dark', hidden: true, textContent: '' });
        return elements.get(id);
      },
    },
    location: {
      get href() { return url.href; }, get pathname() { return url.pathname; },
      get search() { return url.search; }, get hash() { return url.hash; },
      replace(next) { redirects.push(new URL(next, url).href); },
    },
    history: { replaceState(_state, _title, target) { url = new URL(target, url); } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    Theme: { url(target) {
      const next = new URL(target, url), fragment = new URLSearchParams(next.hash.slice(1));
      fragment.set('theme', 'light'); next.hash = fragment.toString(); return next.href;
    } },
    window: { PageLoad: { ready() { ready = true; } } },
    fetch: async () => response(401),
  };
  originals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
});
afterEach(() => {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test('an expired local login automatically returns to the owned device with its task and theme', async () => {
  url.search = '?task=n2%3A21';
  await run();
  assert.equal(redirects.length, 1);
  const target = new URL(redirects[0]);
  assert.equal(target.origin, cloud);
  assert.equal(target.pathname, '/local/open/' + device);
  assert.equal(target.searchParams.get('task'), 'n2:21');
  assert.equal(new URLSearchParams(target.hash.slice(1)).get('theme'), 'light');
  assert.equal(ready, false, 'the transition continues without waiting for a click');
  assert.ok([...storage.values()].every(value => /^\d+$/.test(value)));
});

test('a failed automatic recovery stops on a usable retry page instead of redirecting forever', async () => {
  await run();
  redirects.length = 0;
  await run();
  assert.deepEqual(redirects, []);
  assert.equal(elements.get('entry-retry').hidden, false);
  assert.equal(ready, true);
});

test('a valid local login returns directly to the original task, including while cloud is unavailable', async () => {
  globalThis.fetch = async route => { assert.equal(route, '/local/status'); return response(200); };
  storage.set('switchyard-local-recovery:' + device, String(Date.now()));
  await run();
  assert.equal(redirects[0], 'http://127.0.0.1:4500/?task=48#theme=light');
  assert.equal(storage.size, 0);
});

test('a temporary local network failure does not discard the session or send the user to cloud', async () => {
  globalThis.fetch = async () => { throw new TypeError('Network unavailable'); };
  await run();
  assert.deepEqual(redirects, []);
  assert.equal(ready, true);
  assert.equal(elements.get('entry-retry').hidden, false);
  assert.equal(elements.get('entry-error').hidden, false);
});

test('rejected one-use credentials show the error and are never automatically replayed', async () => {
  url.hash = 'code=expired-test-code&device=' + device;
  let calls = 0;
  globalThis.fetch = async route => { calls++; assert.equal(route, '/local/session'); return response(401, { error: '链接已失效' }); };
  await run();
  assert.equal(calls, 1);
  assert.equal(url.hash, '');
  assert.deepEqual(redirects, []);
  assert.equal(elements.get('entry-error').textContent, '链接已失效');
  assert.equal(ready, true);
});
