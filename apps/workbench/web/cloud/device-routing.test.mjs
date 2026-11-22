import test from 'node:test';
import assert from 'node:assert/strict';
import { localDevice, devicePath, beginLocalConfirmation, confirmLocalDevice, forgetLocalDevice, preferredDevice, rememberWorkspace } from './device-routing.js';
const a = '11111111-1111-1111-1111-111111111111', b = '22222222-2222-2222-2222-222222222222';
const origin = 'http://127.0.0.1:64324';
function storage(t) {
  const previous = [globalThis.localStorage, globalThis.sessionStorage];
  const memory = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
  globalThis.localStorage = memory(); globalThis.sessionStorage = memory();
  t.after(() => { [globalThis.localStorage, globalThis.sessionStorage] = previous; });
}
test('only a matching same-tab confirmation remembers this computer, scoped by account', t => {
  storage(t);
  const nonce = beginLocalConfirmation('alice', a, origin, 'n2:3');
  assert.equal(localDevice('alice'), null);
  assert.throws(() => confirmLocalDevice('wrong', a, 'alice'));
  assert.throws(() => confirmLocalDevice(nonce, b, 'alice'));
  assert.throws(() => confirmLocalDevice(nonce, a, 'bob'));
  assert.equal(confirmLocalDevice(nonce, a, 'alice'), origin + '/local/open?task=n2%3A3');
  assert.equal(devicePath(a, 'alice', '3'), '/local/open/' + a + '?task=3');
  assert.equal(devicePath(b, 'alice'), '/workspace/' + b + '/');
  assert.equal(devicePath(a, 'bob'), '/workspace/' + a + '/');
  assert.throws(() => confirmLocalDevice(nonce, a, 'alice'));
  assert.equal(beginLocalConfirmation('alice', a, origin), '');
  forgetLocalDevice('alice', b); assert.ok(localDevice('alice'));
  forgetLocalDevice('alice', a); assert.equal(localDevice('alice'), null);
});
test('expired callbacks and non-loopback destinations cannot change routing', t => {
  storage(t);
  const nonce = beginLocalConfirmation('alice', a, origin);
  const pending = JSON.parse(sessionStorage.getItem('switchyard-local-confirmation'));
  sessionStorage.setItem('switchyard-local-confirmation', JSON.stringify({ ...pending, expires: 0 }));
  assert.throws(() => confirmLocalDevice(nonce, a, 'alice'));
  assert.equal(localDevice('alice'), null);
  for (const bad of ['https://evil.example', 'http://127.0.0.1:5555/redirect', 'http://user@127.0.0.1:5555']) {
    assert.equal(beginLocalConfirmation('alice', a, bad), '');
    localStorage.setItem('switchyard-local-device:alice', JSON.stringify({ device: a, origin: bad }));
    assert.equal(localDevice('alice'), null);
  }
});
test('blocked browser storage does not prevent an authenticated local session', t => {
  storage(t);
  const nonce = beginLocalConfirmation('alice', a, origin);
  localStorage.setItem = () => { throw Error('blocked'); };
  assert.equal(confirmLocalDevice(nonce, a, 'alice'), origin + '/local/open');
  sessionStorage.setItem = () => { throw Error('blocked'); };
  assert.equal(beginLocalConfirmation('alice', a, origin), '');
});

test('workspace preference is account-scoped and must still exist in the owned device directory', t => {
  storage(t);
  const items = [{ id: a, online: true }, { id: b, online: true }];
  rememberWorkspace('alice', b);
  assert.equal(preferredDevice(items, 'alice').id, b);
  assert.equal(preferredDevice(items, 'bob').id, a);
  assert.equal(preferredDevice([items[0]], 'alice').id, a);
  assert.equal(preferredDevice([items[0], { id: b, online: false }], 'alice').id, a);
  assert.equal(preferredDevice([], 'alice'), null);
});
