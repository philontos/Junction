import test from 'node:test';
import assert from 'node:assert/strict';
import { contextReference, withContext, withView, safeWorkspaceReturn } from './context-link.js';
import { beginLocalConfirmation, confirmLocalDevice } from './device-routing.js';
const a = '11111111-1111-1111-1111-111111111111', b = '22222222-2222-2222-2222-222222222222';
const ref = { context: a, revision: b }, query = `context=${a}&revision=${b}`;
test('pinned Context survives relay, local login, confirmation and retry links', t => {
  const previous = [globalThis.localStorage, globalThis.sessionStorage];
  const store = () => { const data = new Map(); return { getItem: k => data.get(k) || null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }; };
  globalThis.localStorage = store(); globalThis.sessionStorage = store();
  t.after(() => { [globalThis.localStorage, globalThis.sessionStorage] = previous; });
  const url = withContext(`/workspace/${a}/?task=2`, ref);
  assert.equal(safeWorkspaceReturn(url), url);
  assert.deepEqual(contextReference(new URL(url, 'http://fixture').searchParams), ref);
  assert.equal(withContext('http://127.0.0.1:1234/local/open#code=secret', ref), `http://127.0.0.1:1234/local/open?${query}#code=secret`);
  const nonce = beginLocalConfirmation('alice', a, 'http://127.0.0.1:1234', null, ref);
  assert.equal(confirmLocalDevice(nonce, a, 'alice'), `http://127.0.0.1:1234/local/open?${query}`);
});
test('return links never accept an external origin, arbitrary parameters, or a partial Context', () => {
  for (const link of ['https://evil.example', '//evil.example', `/workspace/${a}/?next=//evil.example`, `/workspace/${a}/?context=${a}`, `/workspace/${a}/?task=javascript:bad`]) assert.equal(safeWorkspaceReturn(link), null);
  assert.equal(withContext('/devices', { context: '../private', revision: b }), '/devices');
  assert.equal(contextReference(new URLSearchParams(`context=${a}`)), null);
});

test('Context view is preserved through a local confirmation without expanding return-link permissions', t => {
  const previous = [globalThis.localStorage, globalThis.sessionStorage];
  const store = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
  globalThis.localStorage = store(); globalThis.sessionStorage = store();
  t.after(() => { [globalThis.localStorage, globalThis.sessionStorage] = previous; });
  const link = withView(withContext(`/workspace/${a}/?task=2`, ref), 'contexts');
  assert.equal(safeWorkspaceReturn(link), link);
  assert.equal(safeWorkspaceReturn(`/workspace/${a}/?view=https://evil.example`), null);
  const nonce = beginLocalConfirmation('alice', a, 'http://127.0.0.1:1234', '2', ref, 'contexts');
  assert.equal(confirmLocalDevice(nonce, a, 'alice'), withView(withContext('http://127.0.0.1:1234/local/open?task=2', ref), 'contexts'));
});
