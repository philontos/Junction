const $ = id => document.getElementById(id);
import { devicePath, preferredDevice, rememberWorkspace } from './device-routing.js';
import { discoverLocalDevice } from './local-discovery.js';
import { contextReference, withContext, safeWorkspaceReturn } from './context-link.js';
import { reconcileChildren } from '../js/core/keyed-list.js';
import { preloadWorkbenchAssets } from './workbench-preload.js';
I18N.init();
Theme.init();
function renderThemeToggle() {
  const toLight = Theme.theme === 'dark';
  $('theme-toggle').textContent = toLight ? '☀️' : '🌙';
  $('theme-toggle').title = toLight ? '切换浅色主题' : '切换深色主题';
  $('theme-toggle').setAttribute('aria-label', $('theme-toggle').title);
}
Theme.onChange = renderThemeToggle;
$('theme-toggle').onclick = () => Theme.toggle();
renderThemeToggle();
const setupCode = new URLSearchParams(location.hash.slice(1)).get('setup');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
let signedIn = false, currentUser = '', navigating = false;
let registrationOpen = false, authMode = setupCode ? 'activate' : 'login';
let contextsPage = location.pathname !== '/workbench';
let continuation = contextReference(new URLSearchParams(location.search));
let directory = [], directoryReady = false, directoryRequest, menuSignature = '', directoryError = '';
let routeEpoch = 0, managerPromise, managerReference;
const contextUI = import('./contexts.js');
const positions = new Map();
async function api(route, body, method = 'POST') {
  let response;
  try { response = await fetch('/hub/' + route, {signal:AbortSignal.timeout(15000), ...(body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })}); }
  catch { throw new Error('网络连接失败，请检查网络后重试。'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请稍后再试。');
  return result;
}
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function auth() {
  signedIn = false; $('auth').hidden = false; $('workspace-entry').hidden = true; $('portal-device-switcher').hidden = true; $('account').hidden = true; $('context-space').hidden = true; $('primary-nav').hidden = true;
  const activating=authMode==='activate', registering=authMode==='register';
  $('auth-title').textContent=activating ? '设置你的登录密码' : registering ? '创建 Junction 账号' : '登录 Junction';
  $('auth-description').textContent=activating ? '设置后，即可安装节点并进入工作台。' : registering ? '连接自己的设备，共享工作 Context。' : '连接你的设备，继续工作。';
  $('user-label').hidden=activating; $('user').required=!activating;
  $('user').maxLength=registering ? 32 : 64; $('user').minLength=registering ? 3 : 1;
  $('user').autocapitalize='none'; $('user').spellcheck=false;
  if(registering)$('user').pattern='[A-Za-z0-9][A-Za-z0-9_.\\-]{2,31}';else $('user').removeAttribute('pattern');
  $('user').placeholder=registering ? '3–32 位字母、数字或 . _ -' : '你的账号';
  $('password').minLength=authMode==='login' ? 1 : 12;
  $('password').autocomplete=authMode==='login' ? 'current-password' : 'new-password';
  $('password').placeholder=authMode==='login' ? '输入密码' : '至少 12 个字符';
  $('submit').textContent=activating ? '设置并进入' : registering ? '注册并进入' : '登录';
  $('auth-switch').hidden=activating || !registrationOpen;
  $('auth-switch-label').textContent=registering ? '已有账号？' : '还没有账号？';
  $('auth-toggle').textContent=registering ? '返回登录' : '注册账号';
}

function enterDevice(device, reference = continuation) {
  rememberWorkspace(currentUser, device.id);
  navigating = true;
  location.assign(Theme.url(withContext(devicePath(device.id, currentUser), reference)));
}
function showDevices(event) {
  managerReference = event?.detail?.context ? event.detail : continuation;
  $('portal-device-switcher').open = false;
  managerPromise ||= import('./device-manager.js').then(({ createDeviceManager }) => createDeviceManager(currentUser, {
    getReference: () => managerReference,
    onDevices(items) { directory = items; directoryReady = true; renderDirectory(); },
  }));
  managerPromise.then(manager => manager.open()).catch(e => { managerPromise = null; error(e.message); });
}
window.addEventListener('junction:manage-devices', showDevices);
function renderDirectory() {
  const selected = preferredDevice(directory, currentUser);
  $('portal-device-name').textContent = selected?.name || '选择设备';
  $('portal-device-dot').classList.toggle('online', !!selected?.online);
  const signature = JSON.stringify([directory.map(d => [d.id, d.name, !!d.online]), selected?.id, directoryReady, directoryError, continuation]);
  if (signature === menuSignature) return;
  menuSignature = signature;
  const list = $('portal-device-list');
  const rows = [];
  for (const device of directory) {
    const row = document.createElement('a'); row.className = 'cloud-device-option'; row.dataset.themeLink = '';
    row.classList.toggle('current', device.id === selected?.id);
    if (device.online) row.href = withContext(devicePath(device.id, currentUser), continuation);
    else { row.setAttribute('aria-disabled', 'true'); row.tabIndex = -1; }
    const dot = document.createElement('span'); dot.className = 'cloud-dot' + (device.online ? ' online' : '');
    const info = document.createElement('span'); info.className = 'cloud-option-info';
    const name = document.createElement('span'); name.className = 'cloud-option-name'; name.textContent = device.name;
    const status = document.createElement('span'); status.className = 'cloud-option-status'; status.textContent = device.online ? '在线' : '离线';
    info.append(name, status); row.append(dot, info);
    row.onclick = event => {
      if (!device.online) { event.preventDefault(); return; }
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); enterDevice(device);
    };
    rows.push(row);
  }
  if (!rows.length) {
    const note = document.createElement('div'); note.className = 'cloud-device-message';
    note.textContent = directoryError || (directoryReady ? '还没有连接设备' : '正在读取设备…'); rows.push(note);
  }
  reconcileChildren(list, rows);
}
function refreshDirectory() {
  return directoryRequest ||= (async () => {
    try {
      const { items } = await api('devices');
      // Identity checks run independently of Context. Never route a confirmed
      // local device through the relay just because discovery is still pending.
      const discovery = await discoverLocalDevice(currentUser, items);
      directory = items; directoryReady = true;
      directoryError = discovery.blocked ? '请允许浏览器访问本地网络后重试。' : '';
      renderDirectory();
    } catch (e) { directoryError = e.message; renderDirectory(); }
    finally { directoryRequest = null; }
  })();
}
async function openWorkbench(epoch) {
  $('workspace-entry-action').hidden = true;
  $('workspace-entry-status').textContent = '正在打开工作设备…';
  if (!directoryReady) await refreshDirectory();
  if (epoch !== routeEpoch || contextsPage) return;
  const device = preferredDevice(directory, currentUser);
  if (device?.online && !directoryError) { enterDevice(device); return; }
  $('workspace-entry-status').textContent = directoryError || (directory.length ? '设备暂时离线，连接后即可继续工作。' : '连接一台设备，即可创建任务。');
  $('workspace-entry-action').textContent = directoryError ? '重试连接' : '连接设备';
  $('workspace-entry-action').hidden = false;
  $('workspace-entry-action').onclick = directoryError ? () => { directoryReady = false; void openWorkbench(routeEpoch); } : showDevices;
}
function showPage(pathname = location.pathname, query = location.search, push = false) {
  const epoch = ++routeEpoch;
  positions.set(contextsPage ? '/contexts' : '/workbench', $('portal-main').scrollTop);
  if (push) history.pushState(null, '', pathname + query);
  contextsPage = pathname !== '/workbench';
  continuation = contextReference(new URLSearchParams(query));
  document.title = (contextsPage ? 'Context' : '工作台') + ' · Junction';
  for (const [id, active] of [['context-nav', contextsPage], ['workbench-nav', !contextsPage]]) {
    if (active) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
  }
  $('auth').hidden = true; $('account').hidden = $('primary-nav').hidden = $('portal-device-switcher').hidden = false;
  $('context-space').hidden = !contextsPage; $('workspace-entry').hidden = contextsPage;
  error(); $('portal-main').scrollTop = positions.get(contextsPage ? '/contexts' : '/workbench') || 0;
  const loading = contextsPage ? contextUI.then(m => m.openContextSpace(currentUser)) : openWorkbench(epoch);
  loading.catch(e => { if (epoch === routeEpoch) error(e.message); });
  if (pathname === '/devices') showDevices();
  renderDirectory();
}
async function workspace(user, username = user) {
  signedIn = true; currentUser = user; $('username').textContent = username;
  preloadWorkbenchAssets();
  const next = safeWorkspaceReturn(new URLSearchParams(location.search).get('next'));
  if (next) { navigating = true; location.replace(Theme.url(next)); return; }
  showPage(setupCode ? '/devices' : location.pathname, location.search, !!setupCode);
  void refreshDirectory();
}
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!signedIn || !link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || !['/', '/contexts', '/devices', '/workbench'].includes(url.pathname)) return;
  event.preventDefault();
  if (url.pathname === '/devices') { showDevices(); return; }
  if (url.pathname === location.pathname && url.search === location.search) return;
  showPage(url.pathname, url.search, true);
});
$('manage-devices').onclick = showDevices;
$('portal-device-switcher').addEventListener('toggle', () => { if ($('portal-device-switcher').open) void refreshDirectory(); });
document.addEventListener('click', event => { if (!$('portal-device-switcher').contains(event.target)) $('portal-device-switcher').open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('portal-device-switcher').open) { $('portal-device-switcher').open = false; $('portal-device-switcher').querySelector('summary').focus(); } });
window.addEventListener('popstate', () => { if (signedIn) showPage(); });
window.addEventListener('pageshow', event => { if (event.persisted && signedIn) { navigating = false; showPage(); void refreshDirectory(); } });
$('auth-form').onsubmit = async event => {
  event.preventDefault(); error(); $('submit').disabled = true; $('auth-toggle').disabled=true;
  const label=$('submit').textContent;
  $('submit').textContent=authMode==='register' ? '正在创建账号…' : '正在登录…'; $('auth-form').setAttribute('aria-busy','true');
  try {
    const result = await api(authMode, authMode==='activate' ? { code: setupCode, password: $('password').value } : { user: $('user').value.trim(), password: $('password').value });
    $('password').value = ''; await workspace(result.user_id,result.username);
  } catch (e) { error(e.message); } finally { $('submit').disabled = false; $('auth-toggle').disabled=false; $('submit').textContent=label; $('auth-form').removeAttribute('aria-busy'); }
};
$('auth-toggle').onclick = () => { authMode=authMode==='login' ? 'register' : 'login'; $('password').value=''; error(); auth(); $('user').focus(); };
$('logout').onclick = async () => { try { await api('logout', {}); try { sessionStorage.removeItem('switchyard-install:'+currentUser); sessionStorage.removeItem('junction-context-cards:'+currentUser); } catch {} location.href = '/'; } catch (e) { error(e.message); } };
try { const current = await api('session'); registrationOpen=current.registration_open===true; if (setupCode || !current.user_id) auth(); else await workspace(current.user_id,current.username); }
catch (e) { auth(); error(e.message); }
finally { if (!navigating) window.PageLoad.ready(); }
setInterval(() => { if (signedIn && !document.hidden) void refreshDirectory(); }, 15000);
