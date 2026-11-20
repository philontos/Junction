const meta = name => document.querySelector(`meta[name="${name}"]`).content;
const mode = meta('local-entry-mode'), device = meta('switchyard-device-id');
const fragment = new URLSearchParams(location.hash.slice(1));
const task = fragment.get('task') || new URLSearchParams(location.search).get('task');
const validTask = value => typeof value === 'string' && /^(?:[1-9]\d*|n[1-9]\d*:[1-9]\d*)$/.test(value);
// Remove the one-use credential before loading the workbench or navigating.
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const retry = document.getElementById('entry-retry');
if (validTask(task)) {
  retry.href += '?task=' + encodeURIComponent(task);
  document.getElementById('entry-cloud').href += '?task=' + encodeURIComponent(task);
}
const destination = '/' + (validTask(task) ? '?task=' + encodeURIComponent(task) : '');
async function request(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '连接未完成，请重试。');
  return result;
}
try {
  if (mode === 'cloud') {
    const grant = await request('/hub/devices/' + device + '/local-access', { task_id: validTask(task) ? task : undefined });
    const url = new URL(grant.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/local/open' || url.username || url.password || new URLSearchParams(url.hash.slice(1)).get('device') !== device) throw new Error('节点返回了无效的本机地址。');
    location.replace(url.href);
  } else if (fragment.get('code')) {
    await request('/local/session', { code: fragment.get('code'), device_id: fragment.get('device') });
    location.replace(destination);
  } else {
    const response = await fetch('/local/status', { signal: AbortSignal.timeout(3000) });
    if (response.ok) location.replace(destination);
    else {
      document.getElementById('entry-status').textContent = '从云端确认账号后，即可在本机继续工作。';
      retry.hidden = false; retry.textContent = '打开本机工作台';
    }
  }
} catch (error) {
  document.getElementById('entry-status').textContent = '尚未进入本机工作台';
  document.getElementById('entry-error').textContent = error.name === 'TimeoutError' || error instanceof TypeError ? '连接暂时不可用，请确认本机节点已启动后重试。' : error.message;
  document.getElementById('entry-error').hidden = false;
  retry.hidden = false;
}
