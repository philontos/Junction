import { beginLocalConfirmation, confirmLocalDevice, validTask } from './device-routing.js';
import { beginLocalRecovery, clearLocalRecovery } from './local-session.js';
const meta = name => document.querySelector(`meta[name="${name}"]`).content;
const mode = meta('local-entry-mode'), device = meta('switchyard-device-id');
const cloudOrigin = meta('switchyard-cloud-origin');
const fragment = new URLSearchParams(location.hash.slice(1));
const task = fragment.get('task') || new URLSearchParams(location.search).get('task');
// Remove the one-use credential before loading the workbench or navigating.
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const retry = document.getElementById('entry-retry');
if (validTask(task)) {
  const url = new URL(retry.href);
  url.searchParams.set('task', task);
  retry.href = url.href;
}
const destination = '/' + (validTask(task) ? '?task=' + encodeURIComponent(task) : '');
async function request(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '连接未完成，请重试。');
  return result;
}
try {
  if (mode === 'confirm') {
    const response = await fetch('/hub/session', { signal: AbortSignal.timeout(15000) });
    const account = await response.json();
    if (!response.ok || !account.user_id) throw new Error('登录已过期，请返回工作台重新登录。');
    location.replace(Theme.url(confirmLocalDevice(fragment.get('confirm'), fragment.get('device'), account.user_id)));
  } else if (mode === 'cloud') {
    const grant = await request('/hub/devices/' + device + '/local-access', { task_id: validTask(task) ? task : undefined });
    const url = new URL(grant.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/local/open' || url.username || url.password || new URLSearchParams(url.hash.slice(1)).get('device') !== device) throw new Error('节点返回了无效的本机地址。');
    const nonce = beginLocalConfirmation(grant.user_id, device, url.origin, task);
    if (nonce) { const params = new URLSearchParams(url.hash.slice(1)); params.set('confirm', nonce); url.hash = params.toString(); }
    location.replace(Theme.url(url.href));
  } else if (fragment.get('code')) {
    await request('/local/session', { code: fragment.get('code'), device_id: fragment.get('device') });
    if (fragment.get('confirm')) location.replace(Theme.url(cloudOrigin + '/local/connected#' + new URLSearchParams({ confirm: fragment.get('confirm'), device })));
    else location.replace(Theme.url(destination));
  } else {
    const response = await fetch('/local/status', { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      clearLocalRecovery(device);
      location.replace(Theme.url(destination));
    } else if (response.status === 401 && beginLocalRecovery(device)) {
      document.getElementById('entry-status').textContent = '正在确认账号并恢复连接…';
      location.replace(Theme.url(retry.href));
    } else {
      document.getElementById('entry-status').textContent = '从云端确认账号后，即可在本机继续工作。';
      retry.hidden = false; retry.textContent = '重新连接';
      window.PageLoad.ready();
    }
  }
} catch (error) {
  document.getElementById('entry-status').textContent = '尚未连接这台电脑';
  document.getElementById('entry-error').textContent = error.name === 'TimeoutError' || error instanceof TypeError ? '连接暂时不可用，请确认本机节点已启动后重试。' : error.message;
  document.getElementById('entry-error').hidden = false;
  retry.hidden = mode === 'confirm';
  window.PageLoad.ready();
}
