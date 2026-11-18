const $ = id => document.getElementById(id);
import { installationView } from './install-progress.js';
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
if (location.hash) history.replaceState(null, '', location.pathname);
let signedIn = false, installationId = '', installationKey = '', lastDevices = '', refreshing = false;
async function api(route, body, method = 'POST') {
  const response = await fetch('/hub/' + route, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请稍后再试。');
  return result;
}
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function auth() {
  signedIn = false; $('auth').hidden = false; $('workspace').hidden = true; $('account').hidden = true;
  if (setupCode) {
    $('auth-title').textContent = '设置你的登录密码';
    $('auth-description').textContent = '设置后，即可安装节点并进入工作台。';
    $('user-label').hidden = true; $('user').required = false;
    $('password').minLength = 12; $('password').autocomplete = 'new-password'; $('password').placeholder = '至少 12 个字符';
    $('submit').textContent = '设置并进入';
  }
}
async function workspace(user) {
  signedIn = true; $('auth').hidden = true; $('workspace').hidden = false; $('account').hidden = false; $('username').textContent = user;
  installationKey='switchyard-install:'+user;
  try { installationId=sessionStorage.getItem(installationKey) || ''; } catch {}
  await refresh();
}
function renderInstallation(record) {
  const view=installationView(record);
  $('setup').hidden=false;
  $('setup-status').textContent=view.title;
  $('setup-status').previousElementSibling.className='dot '+view.tone;
  $('setup-detail').textContent=view.detail;
  $('setup-progress').hidden=record.status==='pending';
  $('setup-progress').value=view.progress;
  if(!$('command').textContent)$('command').parentElement.hidden=true;
  $('retry-install').hidden=!(view.retry || (!$('command').textContent && !view.complete));
  $('setup-enter').hidden=!view.complete;
  if(view.complete){
    $('setup-enter').href='/workspace/'+encodeURIComponent(record.device_id)+'/';
    $('command').parentElement.hidden=true; $('setup-help').hidden=true;
    try { sessionStorage.removeItem(installationKey); } catch {}
  }
}
const computer = '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/></svg>';
async function refresh() {
  if (!signedIn || refreshing) return;
  refreshing=true;
  try {
  const [{items}, installation] = await Promise.all([api('devices'),installationId ? api('installations/'+installationId) : null]);
  if(installation)renderInstallation(installation);
  const signature = JSON.stringify(items);
  if (signature === lastDevices) return;
  lastDevices = signature; $('devices').replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.innerHTML = '<strong>把你的电脑接入工作台</strong><p>安装一次本机节点，之后打开这个网页就能继续工作。</p>';
    $('devices').append(empty);
  }
  for (const d of items) {
    const card = document.createElement('article'); card.className = 'device';
    card.innerHTML = `<div class="device-title"><span class="device-icon">${computer}</span><div><div class="device-name"></div><div class="status"><span class="dot ${d.online ? 'online' : ''}"></span>${d.online ? '在线 · 在此设备执行' : '离线 · 等待节点连接'}</div></div></div><div class="device-actions"><a class="enter ${d.online ? '' : 'offline'}">进入工作台 →</a><button class="text">解除绑定</button></div>`;
    card.querySelector('.device-name').textContent = d.name;
    const enter = card.querySelector('a');
    if (d.online) enter.href = '/workspace/' + encodeURIComponent(d.id) + '/';
    else { enter.setAttribute('aria-disabled', 'true'); enter.textContent = '设备离线'; }
    card.querySelector('button').onclick = async () => {
      if (!confirm(`解除「${d.name}」的绑定？云端将不能再控制它，本机任务仍会保留。`)) return;
      try { await api('devices/' + d.id, {}, 'DELETE'); await refresh(); } catch (e) { error(e.message); }
    };
    $('devices').append(card);
  }
  } finally { refreshing=false; }
}
$('auth-form').onsubmit = async event => {
  event.preventDefault(); error(); $('submit').disabled = true;
  try {
    const result = await api(setupCode ? 'activate' : 'login', setupCode ? { code: setupCode, password: $('password').value } : { user: $('user').value.trim(), password: $('password').value });
    $('password').value = ''; await workspace(result.user_id);
  } catch (e) { error(e.message); } finally { $('submit').disabled = false; }
};
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
$('close-setup').onclick = () => { $('setup').hidden = true; installationId=''; try { sessionStorage.removeItem(installationKey); } catch {} };
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('command').textContent); $('copy').textContent = '已复制'; setTimeout(() => { $('copy').textContent = '复制命令'; }, 1500); }
  catch { error('请选中命令复制到本机终端。'); }
};
try { const current = await api('session'); if (setupCode || !current.user_id) auth(); else await workspace(current.user_id); }
catch (e) { auth(); error(e.message); }
finally { $('cloud-loading').hidden = true; }
setInterval(() => { if (signedIn && !document.hidden) refresh().catch(e => error(e.message)); }, 5000);
