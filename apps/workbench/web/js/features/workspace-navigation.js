import { initJunction, refreshJunction } from './junction.js';

// Both surfaces stay mounted. In particular, hiding the workbench must not
// collapse its PTY viewport, recreate xterm, or reconnect its WebSocket.
export function initWorkspaceNavigation(hooks) {
  const workbench = document.querySelector('.wrap');
  const shell = document.createElement('main'); shell.className = 'workspace-surfaces';
  workbench.before(shell); shell.append(workbench);
  shell.dataset.loading = 'true';
  const initial = document.createElement('div'); initial.className = 'workspace-initial'; initial.setAttribute('role', 'status');
  initial.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>正在读取任务…</span>';
  shell.append(initial);
  const contexts = document.createElement('section'); contexts.id = 'context-space';
  contexts.className = 'workspace-contexts'; contexts.hidden = true;
  contexts.setAttribute('aria-label', 'Context'); shell.append(contexts);
  const mount = document.createElement('div'); mount.className = 'workspace-context-inner'; contexts.append(mount);
  const workLink = document.getElementById('workbench-nav'), contextLink = document.getElementById('junction-nav');
  const brand = document.querySelector('header .brand');
  let current = '', refreshing;
  const refresh = () => refreshing ||= refreshJunction().finally(() => { refreshing = null; });
  function href(view) {
    const url = new URL(location.href);
    if (view === 'contexts') url.searchParams.set('view', view); else url.searchParams.delete('view');
    return url.pathname + url.search + url.hash;
  }
  function show(view, push = false) {
    view = view === 'contexts' ? view : 'workbench';
    if (push && current !== view) history.pushState({ ...history.state, junctionView: view }, '', href(view));
    if (current !== view) {
      current = view;
      shell.dataset.view = view;
      workbench.inert = view !== 'workbench' || shell.dataset.loading === 'true';
      workbench.setAttribute('aria-hidden', String(view !== 'workbench'));
      contexts.hidden = view !== 'contexts';
      for (const [link, key] of [[workLink, 'workbench'], [contextLink, 'contexts']]) {
        if (key === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      }
      document.title = (view === 'contexts' ? 'Context' : I18N.t('workspace.home')) + ' · Junction';
      // No fade-to-empty animation on navigation. Only new data/cards fade in.
      if (view === 'workbench') window.dispatchEvent(new Event('resize'));
    }
    workLink.href = brand.href = href('workbench'); contextLink.href = href('contexts');
    if (view === 'contexts') void refresh();
  }
  const device = document.getElementById('cloud-device-switcher');
  initJunction(hooks, { mount, managed: !!device,
    userId: device?.dataset.userId,
    cacheKey: device ? 'junction-context-cards:' + device.dataset.userId : undefined,
    showWorkbench: () => show('workbench', true),
  });
  for (const [link, view] of [[workLink, 'workbench'], [brand, 'workbench'], [contextLink, 'contexts']]) {
    link.addEventListener('click', event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); show(view, true);
    });
  }
  contextLink.addEventListener('pointerenter', refresh);
  contextLink.addEventListener('focus', refresh);
  window.addEventListener('popstate', () => show(new URLSearchParams(location.search).get('view')));
  show(new URLSearchParams(location.search).get('view'));
  return {
    warm: refresh,
    ready(error) {
      if (error) {
        const message = document.createElement('span'); message.textContent = error;
        const retry = document.createElement('button'); retry.className = 'sec'; retry.textContent = '重试'; retry.onclick = () => location.reload();
        initial.replaceChildren(message, retry); return;
      }
      shell.dataset.loading = 'false'; initial.hidden = true;
      workbench.inert = current !== 'workbench';
    },
  };
}
