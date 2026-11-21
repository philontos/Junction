import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./theme.js', import.meta.url), 'utf8');
function browser(href, { storage = new Map(), blocked = false, links = [] } = {}) {
  const events = new Map(), meta = {}, changes = [];
  const listen = (name, fn) => events.set(name, [...events.get(name) || [], fn]);
  let writes = 0;
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { if (blocked) throw Error('storage blocked'); storage.set(key, value); writes++; },
  };
  const sandbox = {
    URL, URLSearchParams, localStorage, location: new URL(href), addEventListener: listen,
    document: {
      documentElement: { dataset: {} },
      querySelector: () => meta,
      querySelectorAll: () => links,
      addEventListener: listen,
    },
    history: {
      state: { task: 21 },
      replaceState(state, _, next) { this.state = state; sandbox.location = new URL(next, sandbox.location); },
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  sandbox.Theme.onChange = theme => changes.push(theme);
  return {
    ...sandbox, storage, meta, changes, links,
    emit: (name, event = {}) => { for (const fn of events.get(name) || []) fn(event); },
    get writes() { return writes; },
  };
}

test('incoming theme wins before rendering while login and task parameters survive', () => {
  const page = browser('http://127.0.0.1:3100/local/open?task=n2%3A21#code=one-use&device=node&confirm=nonce&theme=light', {
    storage: new Map([['theme', 'dark']]),
  });
  assert.equal(page.Theme.theme, 'light');
  assert.equal(page.document.documentElement.dataset.theme, 'light');
  assert.equal(page.meta.content, '#f5f0e8');
  assert.equal(page.storage.get('theme'), 'light');
  assert.equal(page.location.searchParams.get('task'), 'n2:21');
  const fragment = new URLSearchParams(page.location.hash.slice(1));
  assert.equal(fragment.get('code'), 'one-use');
  assert.equal(fragment.get('device'), 'node');
  assert.equal(fragment.get('confirm'), 'nonce');
  assert.equal(fragment.has('theme'), false);
  assert.deepEqual(page.history.state, { task: 21 });
});

test('cloud and loopback keep the same theme through confirmation, work and return', () => {
  const cloudStorage = new Map([['theme', 'light']]), localStorage = new Map([['theme', 'dark']]);
  const cloud = browser('https://junction.example/', { storage: cloudStorage });
  const local = browser(cloud.Theme.url('http://127.0.0.1:3100/local/open#code=ticket&device=node'), { storage: localStorage });
  assert.equal(local.Theme.theme, 'light');
  const confirmation = browser(local.Theme.url('https://junction.example/local/connected#confirm=nonce&device=node'), { storage: cloudStorage });
  assert.equal(new URLSearchParams(confirmation.location.hash.slice(1)).get('confirm'), 'nonce');
  const workspace = browser(confirmation.Theme.url('http://127.0.0.1:3100/?task=21'), { storage: localStorage });
  assert.equal(workspace.Theme.theme, 'light');
  assert.equal(workspace.location.searchParams.get('task'), '21');
  workspace.Theme.toggle();
  const returned = browser(workspace.Theme.url('https://junction.example/'), { storage: cloudStorage });
  assert.equal(returned.Theme.theme, 'dark');
  assert.equal(cloudStorage.get('theme'), 'dark');
  assert.equal(returned.location.hash, '');
});

test('same-origin tab changes and history restoration update chrome and terminal hooks without echoing writes', () => {
  const page = browser('https://junction.example/workspace/device/');
  page.storage.set('theme', 'light');
  page.emit('storage', { key: 'theme', storageArea: page.localStorage });
  assert.equal(page.Theme.theme, 'light');
  assert.equal(page.meta.content, '#f5f0e8');
  assert.deepEqual(page.changes, ['light']);
  assert.equal(page.writes, 0);
  page.storage.set('theme', 'dark');
  page.emit('storage', { key: 'theme', storageArea: {} });
  assert.equal(page.Theme.theme, 'light', 'session storage is unrelated');
  page.emit('pageshow', { persisted: true });
  assert.equal(page.Theme.theme, 'dark');
  assert.equal(page.meta.content, '#1a1613');
  assert.deepEqual(page.changes, ['light', 'dark']);
  page.Theme.set('light');
  page.storage.clear();
  page.emit('storage', { key: null, storageArea: page.localStorage });
  assert.equal(page.Theme.theme, 'dark');
});

test('new-tab and context-menu links take the current theme without changing their destination or task', () => {
  const link = { href: 'https://junction.example/workspace/device/?task=21' };
  const page = browser('http://127.0.0.1:3100/', { links: [link] });
  page.Theme.set('light');
  assert.equal(new URLSearchParams(new URL(link.href).hash.slice(1)).get('theme'), 'light');
  for (const event of ['click', 'auxclick', 'contextmenu']) {
    const dynamic = { href: 'https://junction.example/local/open/device?task=n2%3A21#theme=dark' };
    page.emit(event, { target: { closest: () => dynamic } });
    const url = new URL(dynamic.href);
    assert.equal(url.origin, 'https://junction.example');
    assert.equal(url.pathname, '/local/open/device');
    assert.equal(url.searchParams.get('task'), 'n2:21');
    assert.equal(url.hash, '#theme=light');
  }
});

test('blocked storage keeps the incoming choice through repeated init and page restoration', () => {
  const page = browser('http://127.0.0.1:3100/#theme=light', { blocked: true, storage: new Map([['theme', 'dark']]) });
  page.Theme.init();
  page.emit('pageshow');
  assert.equal(page.Theme.theme, 'light');
  assert.equal(new URL(page.Theme.url('https://junction.example/')).hash, '#theme=light');
  page.localStorage.getItem = () => { throw Error('storage blocked'); };
  page.Theme.toggle();
  page.emit('pageshow');
  assert.equal(page.Theme.theme, 'dark');
});

test('invalid themes fall back to the saved choice and do not consume account setup codes', () => {
  const page = browser('https://junction.example/#setup=activation&theme=invalid', { storage: new Map([['theme', 'light']]) });
  assert.equal(page.Theme.theme, 'light');
  assert.equal(page.location.hash, '#setup=activation');
  page.Theme.set('invalid');
  assert.equal(page.Theme.theme, 'light');
  assert.equal(browser('https://junction.example/').Theme.theme, 'dark');
});
