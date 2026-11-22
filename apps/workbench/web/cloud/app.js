const $ = id => document.getElementById(id);
import { installationView } from './install-progress.js';
import { devicePath, forgetLocalDevice } from './device-routing.js';
import { discoverLocalDevice } from './local-discovery.js';
import { contextReference, withContext, safeWorkspaceReturn } from './context-link.js';
import { reconcileChildren } from '../js/core/keyed-list.js';
I18N.init();
Theme.init();
const contextsPage = location.pathname !== '/devices';
const continuation = contextReference(new URLSearchParams(location.search));
document.title = (contextsPage ? 'Context' : '工作台') + ' · Junction';
$('workbench-nav').href = withContext('/devices', continuation);
$(contextsPage ? 'context-nav' : 'workbench-nav').setAttribute('aria-current', 'page');
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
if (location.hash) history.replaceState(null, '', location.pathname);
let signedIn = false, installationId = '', installationKey = '', lastDevices = '', refreshing = false;
let registrationOpen = false, authMode = setupCode ? 'activate' : 'login';
let decidingBinding = '';
let currentUser = '', navigating = false, retryDiscovery = false;
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
  signedIn = false; $('auth').hidden = false; $('workspace').hidden = true; $('account').hidden = true; $('context-space').hidden = true; $('primary-nav').hidden = true;
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
async function workspace(user, username = user) {
  signedIn = true; currentUser = user; $('username').textContent = username;
  installationKey='switchyard-install:'+user;
  try { installationId=sessionStorage.getItem(installationKey) || ''; } catch {}
  const next = safeWorkspaceReturn(new URLSearchParams(location.search).get('next'));
  if (next) { navigating = true; location.replace(next); return; }
  if (contextsPage && !setupCode) {
    const { openContextSpace } = await import('./contexts.js');
    await openContextSpace(user);
    $('auth').hidden = true; $('context-space').hidden = false; $('account').hidden = false; $('primary-nav').hidden = false;
    return;
  }
  if (contextsPage) { navigating = true; location.replace('/devices'); return; }
  await refresh();
  if (!navigating) { $('auth').hidden = true; $('workspace').hidden = false; $('account').hidden = false; $('primary-nav').hidden = false; window.PageLoad.fade($('workspace')); }
}
function renderInstallation(record) {
  const view=installationView(record);
  $('setup').hidden=false;
  $('setup-status').textContent=view.title;
  $('setup-status').previousElementSibling.className='dot '+view.tone;
  $('setup-detail').textContent=view.detail;
  $('setup-progress').hidden=record.status==='pending' || record.issue.startsWith('account');
  $('setup-progress').value=view.progress;
  if(!$('command').textContent)$('command').parentElement.hidden=true;
  const conflict=record.account_conflict;
  $('setup-title').textContent=conflict?'确认设备归属':'连接这台电脑';
  $('setup-resume').hidden=record.issue.startsWith('account') || view.complete;
  $('keep-binding').hidden=$('switch-binding').hidden=!conflict;
  $('keep-binding').textContent=decidingBinding==='keep-account'?'正在保留…':'保留原账号';
  $('switch-binding').textContent=decidingBinding==='rebind'?'正在切换…':conflict?`切换到 ${conflict.to_username}`:'切换到当前账号';
  $('keep-binding').disabled=$('switch-binding').disabled=!!decidingBinding;
  $('retry-install').hidden=conflict || record.issue==='account_kept' || !(view.retry || (!$('command').textContent && !view.complete));
  if(conflict || record.issue==='account_kept' || record.issue==='account_changed'){
    $('command').parentElement.hidden=true; $('setup-help').hidden=true;
  }
  $('setup-enter').hidden=!view.complete;
  if(view.complete){
    $('setup-enter').href=withContext('/local/open/'+encodeURIComponent(record.device_id), continuation);
    $('setup-enter').textContent='开始工作 →';
    $('command').parentElement.hidden=true; $('setup-help').hidden=true;
  }
}
function openInstalledLocal(record, items) {
  // An online device is not proof that it belongs to this browser's computer.
  // Only continue the installation initiated in this tab; never guess from the
  // device list. Wait for the local listener's advertised capability as well.
  if (document.hidden || !installationView(record).complete || !items.some(d => d.id === record.device_id && d.online && d.local_workspace)) return;
  installationId = '';
  try { sessionStorage.removeItem(installationKey); } catch {}
  $('setup-status').textContent = '连接成功 · 正在打开本机工作台';
  navigating = true;
  location.replace(withContext('/local/open/' + encodeURIComponent(record.device_id), continuation));
}
const computer = '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/></svg>';
async function refresh() {
  if (!signedIn || refreshing || navigating) return;
  refreshing=true;
  try {
  const id=installationId;
  const [{items}, installation] = await Promise.all([api('devices'),id ? api('installations/'+id) : null]);
  if(installation && installationId===id){
    renderInstallation(installation);
    openInstalledLocal(installation,items);
  }
  if (navigating) return;
  const discovery = await discoverLocalDevice(currentUser, items, { retry: retryDiscovery });
  retryDiscovery = false;
  const local = discovery.local?.device;
  $('install').hidden = items.some(d => d.id === local);
  $('local-detection').hidden = !discovery.blocked;
  const signature = JSON.stringify([local, items.map(d => [d.id, d.name, !!d.online])]);
  if (signature === lastDevices) return;
  lastDevices = signature;
  const existing = new Map([...$('devices').children].map(card => [card.dataset.deviceId, card]));
  const cards = [];
  if (!items.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.innerHTML = '<strong>把你的电脑接入工作台</strong><p>安装一次本机节点，之后打开这个网页就能继续工作。</p>';
    cards.push(empty);
  }
  for (const d of items) {
    const key = JSON.stringify([d.name, !!d.online, d.id === local]);
    const previous = existing.get(d.id);
    if (previous?.dataset.version === key) { cards.push(previous); continue; }
    const card = document.createElement('article'); card.className = 'device';
    card.dataset.deviceId = d.id; card.dataset.version = key;
    card.innerHTML = `<div class="device-title"><span class="device-icon">${computer}</span><div><div class="device-name"></div><div class="status"><span class="dot ${d.online ? 'online' : ''}"></span>${d.id === local ? '本机 · ' : ''}${d.online ? '在线' : '离线 · 等待节点连接'}</div></div></div><div class="device-actions"><a class="enter ${d.online ? '' : 'offline'}">开始工作 →</a><button class="text">解除绑定</button></div>`;
    card.querySelector('.device-name').textContent = d.name;
    const enter = card.querySelector('a');
    if (d.online) {
      enter.href = withContext(devicePath(d.id, currentUser), continuation);
      if (continuation) enter.textContent = '在此设备继续 →';
    }
    else { enter.setAttribute('aria-disabled', 'true'); enter.textContent = '设备离线'; }
    card.querySelector('button').onclick = async () => {
      if (!confirm(`解除「${d.name}」的绑定？云端将不能再控制它，本机任务仍会保留。`)) return;
      try { await api('devices/' + d.id, {}, 'DELETE'); forgetLocalDevice(currentUser, d.id); await refresh(); } catch (e) { error(e.message); }
    };
    cards.push(card);
    window.PageLoad.fade(card);
  }
  reconcileChildren($('devices'), cards);
  } finally { refreshing=false; }
}
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
$('logout').onclick = async () => { try { await api('logout', {}); try { sessionStorage.removeItem(installationKey); } catch {} location.href = '/'; } catch (e) { error(e.message); } };
$('install').onclick = async () => {
  error(); $('install').disabled = true;
  try {
    const { code, origin, installation_id } = await api('pairings', {});
    installationId=installation_id;
    try { sessionStorage.setItem(installationKey,installationId); } catch {}
    // Only the non-secret status ID is kept across reloads. The one-use code
    // is claimed by the installer within ten minutes, never stored in the web.
    $('command').textContent = `curl -fsS '${origin}/install.sh' | bash -s -- '${code}'`;
    $('command').parentElement.hidden = false; $('setup-help').hidden = false; $('setup').hidden = false;
    renderInstallation(await api('installations/'+installationId));
  } catch (e) { error(e.message); } finally { $('install').disabled = false; }
};
$('retry-install').onclick = () => $('install').click();
$('retry-local').onclick = async () => {
  retryDiscovery = true; $('retry-local').disabled = true;
  try { await refresh(); } catch (e) { error(e.message); }
  finally { $('retry-local').disabled = false; }
};
async function decideBinding(action) {
  if(decidingBinding || !installationId)return;
  const labels=[$('keep-binding').textContent,$('switch-binding').textContent];
  decidingBinding=action;error();
  $('keep-binding').disabled=$('switch-binding').disabled=$('install').disabled=$('close-setup').disabled=true;
  $(action==='rebind'?'switch-binding':'keep-binding').textContent=action==='rebind'?'正在切换…':'正在保留…';
  const id=installationId;
  try {await api('installations/'+id+'/'+action,{});}
  catch(e){error(e.message);}
  finally {
    decidingBinding='';$('keep-binding').textContent=labels[0];$('switch-binding').textContent=labels[1];
    $('keep-binding').disabled=$('switch-binding').disabled=$('install').disabled=$('close-setup').disabled=false;
    await refresh().catch(e=>error(e.message));
  }
}
$('keep-binding').onclick=()=>decideBinding('keep-account');
$('switch-binding').onclick=()=>decideBinding('rebind');
$('close-setup').onclick = () => { $('setup').hidden = true; installationId=''; try { sessionStorage.removeItem(installationKey); } catch {} };
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('command').textContent); $('copy').textContent = '已复制'; setTimeout(() => { $('copy').textContent = '复制命令'; }, 1500); }
  catch { error('请选中命令复制到本机终端。'); }
};
try { const current = await api('session'); registrationOpen=current.registration_open===true; if (setupCode || !current.user_id) auth(); else await workspace(current.user_id,current.username); }
catch (e) { auth(); error(e.message); }
finally { if (!navigating) window.PageLoad.ready(); }
setInterval(() => { if (signedIn && !contextsPage && !document.hidden) refresh().catch(e => error(e.message)); }, 5000);
