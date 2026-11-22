import { installationView } from './install-progress.js';
import { devicePath, forgetLocalDevice } from './device-routing.js';
import { discoverLocalDevice } from './local-discovery.js';
import { reconcileChildren } from '../js/core/keyed-list.js';
import { withContext } from './context-link.js';

// Account changes stay on the authenticated cloud origin. Local workbenches
// open this dialog in a separate cloud tab, leaving their PTY session mounted.
export function createDeviceManager(user, { onDevices, onEnter, getReference } = {}) {
  const dialog = document.createElement('dialog'); dialog.className = 'device-manager';
  dialog.setAttribute('aria-labelledby', 'device-manager-title');
  dialog.innerHTML = `
    <section id="workspace">
      <div class="heading"><div><h2 id="device-manager-title">设备</h2><p>连接与管理你的工作设备</p></div><button id="install" class="primary">＋ 连接这台电脑</button><button id="manager-close" class="sec" aria-label="关闭设备管理">×</button></div>
      <div id="devices" class="devices"><div class="portal-section-loading" role="status"><span class="spinner" aria-hidden="true"></span><span>读取设备…</span></div></div>
      <p id="local-detection" class="note" role="status" hidden>本机识别被浏览器阻止，请允许访问本地网络后重试。<button id="retry-local" class="text" type="button">重新识别</button></p>
      <section id="setup" class="setup" hidden>
        <div class="setup-heading"><h2 id="setup-title">连接这台电脑</h2><button id="close-setup" class="text" aria-label="关闭安装面板">关闭</button></div>
        <p id="setup-help">在本机终端执行一次。自动检测并安装缺失的 Node.js、Git、tmux 等工具，每一步验证通过后继续。</p>
        <div class="command"><code id="command"></code><button id="copy">复制命令</button></div>
        <div class="setup-status" role="status"><span class="dot waiting"></span><span id="setup-status">等待执行安装命令</span></div>
        <progress id="setup-progress" max="6" value="0" aria-label="安装进度" hidden></progress>
        <p id="setup-detail" class="note">请在 10 分钟内开始；开始后可在 24 小时内继续。</p>
        <div class="setup-actions"><button id="keep-binding" class="sec" type="button" hidden>保留原账号</button><button id="switch-binding" class="primary" type="button" hidden>切换到当前账号</button><button id="retry-install" class="sec" type="button" hidden>重新生成命令</button><a data-theme-link id="setup-enter" class="enter" hidden>进入工作台 →</a></div>
        <p id="setup-resume" class="note">中断后再次执行即可继续。系统授权在本机确认；Agent 安装和登录由你选择。</p>
      </section>
      <p class="footnote">任务在所选设备执行，共享 Context 保存在 Junction。</p>
    </section>
<p id="device-manager-error" class="error" role="alert" hidden></p>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector('#' + id);
  const reference = () => getReference?.() || null;
  const enter = url => { if (onEnter) onEnter(url); else location.assign(Theme.url(url)); };
  const openDevice = (url, id) => { if (onEnter) onEnter(url, id); else enter(url); };
  const currentUser = user, installationKey = 'switchyard-install:' + user;
  let installationId = '', lastDevices = '', refreshing = false, navigating = false;
  let retryDiscovery = false, decidingBinding = '';
  try { installationId = sessionStorage.getItem(installationKey) || ''; } catch {}
  async function api(route, body, method = 'POST') {
    let response;
    try { response = await fetch('/hub/' + route, {signal:AbortSignal.timeout(15000), ...(body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })}); }
    catch { throw new Error('网络连接失败，请检查网络后重试。'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败，请稍后再试。');
    return result;
  }
  function error(message = '') { $('device-manager-error').textContent = message; $('device-manager-error').hidden = !message; }
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
      $('setup-enter').href=withContext('/local/open/'+encodeURIComponent(record.device_id), reference());
      $('setup-enter').textContent='开始工作 →';
      $('command').parentElement.hidden=true; $('setup-help').hidden=true;
    }
  }
  function openInstalledLocal(record, items) {
    // An online device is not proof that it belongs to this browser's computer.
    // Only continue the installation initiated in this tab; never guess from the
    // device list. Wait for the local listener's advertised capability as well.
    if (!dialog.open || document.hidden || !installationView(record).complete || !items.some(d => d.id === record.device_id && d.online && d.local_workspace)) return;
    installationId = '';
    try { sessionStorage.removeItem(installationKey); } catch {}
    $('setup-status').textContent = '连接成功 · 正在打开本机工作台';
    navigating = true;
    enter(withContext('/local/open/' + encodeURIComponent(record.device_id), reference()));
  }
  const computer = '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/></svg>';
  async function refresh() {
    if (refreshing || navigating) return;
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
    onDevices?.(items, discovery);
    $('install').hidden = items.some(d => d.id === local);
    $('local-detection').hidden = !discovery.blocked;
    const signature = JSON.stringify([local, reference(), items.map(d => [d.id, d.name, !!d.online])]);
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
      const key = JSON.stringify([d.name, !!d.online, d.id === local, reference()]);
      const previous = existing.get(d.id);
      if (previous?.dataset.version === key) { cards.push(previous); continue; }
      const card = document.createElement('article'); card.className = 'device';
      card.dataset.deviceId = d.id; card.dataset.version = key;
      card.innerHTML = `<div class="device-title"><span class="device-icon">${computer}</span><div><div class="device-name"></div><div class="status"><span class="dot ${d.online ? 'online' : ''}"></span>${d.id === local ? '本机 · ' : ''}${d.online ? '在线' : '离线 · 等待节点连接'}</div></div></div><div class="device-actions"><a class="enter ${d.online ? '' : 'offline'}">开始工作 →</a><button class="text">解除绑定</button></div>`;
      card.querySelector('.device-name').textContent = d.name;
      const enter = card.querySelector('a'); enter.dataset.themeLink = '';
      if (d.online) {
        enter.href = withContext(devicePath(d.id, currentUser), reference());
        if (reference()) enter.textContent = '在此设备继续 →';
        enter.onclick = event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); openDevice(enter.getAttribute('href'), d.id); };
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

  $('manager-close').onclick = () => dialog.close();
  dialog.addEventListener('click', event => { if (event.target === dialog) {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  }});
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
  dialog.addEventListener('cancel', event => { if (decidingBinding) event.preventDefault(); });
  setInterval(() => { if (dialog.open && !document.hidden) refresh().catch(e => error(e.message)); }, 5000);
  return {
    open() { if (!dialog.open) dialog.showModal(); void refresh().catch(e => error(e.message)); },
    close() { dialog.close(); },
  };
}
