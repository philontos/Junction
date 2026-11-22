import { initJunction, openJunction } from '../js/features/junction.js';
import { api } from '../js/core/dom.js';
import { discoverLocalDevice } from './local-discovery.js';
import { devicePath } from './device-routing.js';
import { withContext } from './context-link.js';

let initialized = false, refreshing;
export function openContextSpace(user) {
  if (refreshing) return refreshing;
  if (!initialized) {
    const mount = document.getElementById('context-space'); mount.replaceChildren();
    initJunction({}, {
    mount,
    cacheKey: 'junction-context-cards:' + user,
    request: (path, options = {}) => api('/hub/context' + path, {
      ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    }),
    continueContext: (meta, target, actions, valid) => chooseDevice(user, meta, target, actions, valid),
    });
    initialized = true;
  }
  refreshing = openJunction().finally(() => { refreshing = null; });
  return refreshing;
}

function chooseDevice(user, meta, target, actions, valid) {
  const reference = { context: meta.id, revision: meta.revision.id };
  const note = document.createElement('p'); note.className = 'jx-note';
  const submit = document.createElement('button'); submit.id = 'jx-task-submit'; submit.className = 'primary';
  submit.textContent = '在此设备继续 →'; submit.disabled = true; actions.append(submit);
  if (meta.revision.status === 'failed') { note.textContent = '这份记录解析失败，暂时无法继续任务。'; target.append(note); return; }
  const label = document.createElement('label'); label.className = 'jx-field'; label.textContent = '执行设备';
  const select = document.createElement('select'); select.setAttribute('aria-label', '执行设备'); select.disabled = true;
  select.append(new Option('正在读取设备…', '')); label.append(select);
  note.textContent = '下一步选择 Agent 和工作目录。任务在所选设备执行。';
  const manage = document.createElement('a'); manage.className = 'context-manage-link'; manage.dataset.themeLink = '';  manage.href = withContext('/devices', reference); manage.textContent = '连接或管理设备';
  const error = document.createElement('p'); error.className = 'jx-warning'; error.hidden = true; error.setAttribute('role', 'alert');
  const retry = document.createElement('button'); retry.className = 'sec'; retry.textContent = '重新读取'; retry.hidden = true;
  target.append(label, note, manage, error, retry);
  let busy = false;
  const load = async () => {
    if (busy) return; busy = true; select.disabled = submit.disabled = true; error.hidden = retry.hidden = true;
    try {
      const { items } = await api('/hub/devices', { signal: AbortSignal.timeout(15000) });
      if (!valid()) return;
      const discovery = await discoverLocalDevice(user, items, { retry: true });
      if (!valid()) return;
      if (discovery.blocked) throw new Error('请允许浏览器访问本地网络，再重新读取设备。');
      select.replaceChildren();
      if (!items.length) select.append(new Option('还没有连接设备', ''));
      for (const d of items) {
        const local = discovery.local?.device === d.id;
        const option = new Option(`${d.name} · ${local ? '本机 · ' : ''}${d.online ? '在线' : '离线'}`, d.id);
        option.disabled = !d.online; select.append(option);
      }
      const available = items.filter(d => d.online);
      select.value = available.find(d => d.id === discovery.local?.device)?.id || available[0]?.id || '';
      select.disabled = !available.length; submit.disabled = !select.value;
      if (items.length && !available.length) { note.textContent = '设备当前均离线。启动设备节点后重新读取，即可继续。'; retry.hidden = false; }
    } catch (e) {
      if (valid()) { select.replaceChildren(new Option('设备暂时不可用', '')); error.textContent = e.message; error.hidden = retry.hidden = false; }
    } finally { busy = false; }
  };
  select.onchange = () => { submit.disabled = !select.value; };
  retry.onclick = load;
  submit.onclick = () => {
    if (!select.value || submit.disabled) return;
    submit.disabled = true; submit.textContent = '正在进入工作台…';
    location.assign(Theme.url(withContext(devicePath(select.value, user), reference)));
  };
  load();
}
