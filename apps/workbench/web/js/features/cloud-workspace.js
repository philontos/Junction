import { $, nodeBase } from "../core/dom.js";
import { state } from "../core/state.js";
import { duringAutoFollow } from "./mobile.js";
import { devicePath, rememberWorkspace } from "../../cloud/device-routing.js";
import { withView } from "../../cloud/context-link.js";
import { watchLocalSession } from "../../cloud/local-session.js";

let switcher, panel, list, advanced, hostList, hooks;
let devices = [], loading = false, failure = "", expired = false, pending;
let deviceSignature = "";
let storageKey = "", saved, canRemember = false, restoreCancelled = false, hostSignature = "";
let direct = false, cloudOrigin = "", requestedTask = null;
const text = key => t("workspace." + key);
const localHost = () => Object.values(state.hostsById).find(h => h.kind === "local");
const element = (tag, className, label) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label != null) node.textContent = label;
  return node;
};
const validTask = value => Number.isSafeInteger(value) && value > 0 || typeof value === "string" && /^n\d+:\d+$/.test(value);

function remember() {
  if (!canRemember || state.activeHostId == null) return;
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({
      schema_version: 1, host_id: state.activeHostId,
      task_id: validTask(state.selectedTaskId) ? state.selectedTaskId : null,
      scroll_top: $("m-list").scrollTop,
      terminal_view: document.body.classList.contains("view-terminal"),
    }));
  } catch { /* Private browsing/storage limits must not prevent navigation. */ }
}
function cancelRestore() { restoreCancelled = true; }
function chooseHost(id) {
  restoreCancelled = true;
  if(state.activeHostId !== id)hooks.selectHost(id);
  switcher.open = false;
  switcher.querySelector("summary").focus();
  refreshCloudHosts();
}

function renderDevices() {
  // Heartbeats and other server metadata must not replace an unchanged menu.
  const view = devices.length ? "devices" : loading ? "loading" : failure ? "error" : "empty";
  const signature = JSON.stringify([I18N.lang, switcher.dataset.deviceId, view,
    view === "error" ? [failure, expired] : devices.map(d => [d.id, d.name, !!d.online])]);
  if (signature === deviceSignature) return;
  deviceSignature = signature;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.deviceId : null;
  list.replaceChildren();
  list.setAttribute("aria-busy", String(view === "loading"));
  if (view === "loading") {
    const status = element("div", "cloud-device-message");
    status.setAttribute("role", "status");
    status.append(element("span", "spinner"), element("span", "", text("loading")));
    list.append(status);
    return;
  }
  if (view === "error") {
    const status = element("div", "cloud-device-message", failure);
    status.setAttribute("role", "status");
    const retry = element(expired ? "a" : "button", "cloud-menu-action", text(expired ? "expired" : "retry"));
    if (expired) { retry.href = direct ? "/local/open" : "/"; retry.dataset.themeLink = ""; }
    else { retry.type = "button"; retry.onclick = () => refreshDevices(true); }
    list.append(status, retry);
    return;
  }
  for (const device of devices) {
    const current = device.id === switcher.dataset.deviceId;
    const row = element("a", "cloud-device-option" + (current ? " current" : ""));
    row.dataset.deviceId = device.id;
    row.dataset.themeLink = "";
    if (device.online) row.href = direct && current ? "/" : cloudOrigin + devicePath(device.id, switcher.dataset.userId);
    else { row.setAttribute("aria-disabled", "true"); row.tabIndex = -1; }
    if (current) row.setAttribute("aria-current", "location");
    const name = element("span", "cloud-option-name", device.name);
    const subtitle = element("span", "cloud-option-status", text(device.online ? "online" : "offline") + (current ? " · " + text("current") : ""));
    const info = element("span", "cloud-option-info"); info.append(name, subtitle);
    row.append(element("span", "cloud-dot" + (device.online ? " online" : "")), info);
    if (current) row.append(element("span", "cloud-option-check", "✓"));
    // Ordinary links preserve browser support for opening another device in a
    // new tab. A normal click on this node returns from an advanced SSH target.
    row.onclick = event => {
      if (!device.online) { event.preventDefault(); return; }
      if (current && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && localHost()) {
        event.preventDefault(); chooseHost(localHost().id);
      }
    };
    list.append(row);
  }
  if (focused) {
    const replacement = [...list.children].find(row => row.dataset.deviceId === focused && row.hasAttribute("href"));
    (replacement || switcher.querySelector("summary")).focus({ preventScroll: true });
  }
  if (devices.length && switcher.open && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    list.animate([{ opacity: .5 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  }
}

async function refreshDevices(showLoading = false) {
  if (pending) return pending;
  if (showLoading && !devices.length) { loading = true; renderDevices(); }
  pending = (async () => {
    try {
      const response = await fetch(direct ? "/local/devices" : "/hub/devices", { signal: AbortSignal.timeout(10000) });
      if (!response.ok) { expired = response.status === 401 || response.status === 403; throw new Error("devices unavailable"); }
      const result = await response.json();
      if (!Array.isArray(result.items)) throw new Error("invalid devices");
      devices = result.items; failure = ""; expired = false;
    } catch {
      // Keep usable navigation on transient failures, but clear it when access expires.
      if (expired) devices = [];
      failure = text(expired ? "expired" : "failed");
    } finally {
      loading = false; pending = null;
      renderDevices(); repaintCurrent();
    }
  })();
  return pending;
}

function repaintCurrent() {
  const current = devices.find(d => d.id === switcher.dataset.deviceId);
  const label = current?.name || switcher.dataset.deviceName;
  const status = text(current ? current.online ? "online" : "offline" : "unknown");
  const summary = switcher.querySelector("summary");
  summary.title = label + " · " + status;
  summary.setAttribute("aria-label", label + " · " + status + " · " + text("switch"));
  switcher.querySelector(".cloud-current-name").textContent = label;
  $("cloud-current-dot").classList.toggle("online", !!current?.online);
  const host = state.hostsById[state.activeHostId], ssh = host && host.kind !== "local";
  $("cloud-current-ssh").hidden = !ssh;
  $("cloud-current-ssh").textContent = ssh ? "SSH · " + host.name : "";
  if (ssh) summary.title += " → SSH · " + host.name;
}

export function refreshCloudHosts() {
  if (!switcher) return;
  repaintCurrent();
  const hosts = Object.values(state.hostsById);
  const signature = JSON.stringify([I18N.lang, state.activeHostId, hosts.map(h => [h.id, h.name, h.kind, h.status, h.target])]);
  if (signature === hostSignature) return;
  hostSignature = signature;
  hostList.replaceChildren();
  for (const host of hosts) {
    const local = host.kind === "local", active = host.id === state.activeHostId;
    const row = element("button", "cloud-host-option" + (active ? " current" : ""));
    row.type = "button";
    row.dataset.hostId = host.id;
    row.title = local ? switcher.dataset.deviceName : host.target || host.name;
    row.append(element("span", "", local ? text("back") : host.name));
    row.append(element("span", "cloud-option-status", active ? "✓" : local || host.status === "online" ? text("online") : text("offline")));
    // Offline SSH targets remain selectable so their existing recovery/settings
    // controls stay reachable. Choosing one never starts or resumes a task.
    row.onclick = () => chooseHost(host.id);
    hostList.append(row);
  }
}

export function repaintCloudWorkspace() {
  if (!switcher) return;
  panel.setAttribute("aria-label", text("switch"));
  panel.querySelector(".cloud-device-heading").textContent = text("switch");
  advanced.querySelector("summary").textContent = text("advanced");
  advanced.querySelector("p").textContent = text("sshNote");
  advanced.querySelector(".cloud-add-ssh").textContent = text("addSsh");
  if (failure) failure = text(expired ? "expired" : "failed");
  renderDevices(); refreshCloudHosts();
}

export function initCloudWorkspace(callbacks) {
  switcher = $("cloud-device-switcher");
  if (!switcher || (!nodeBase() && switcher.dataset.mode !== "local")) { switcher = null; return; }
  direct = switcher.dataset.mode === "local";
  cloudOrigin = direct ? document.querySelector('meta[name="switchyard-cloud-origin"]')?.content || "" : "";
  hooks = callbacks;
  rememberWorkspace(switcher.dataset.userId, switcher.dataset.deviceId);
  storageKey = "switchyard-workspace:" + switcher.dataset.userId + ":" + (direct ? switcher.dataset.deviceId : nodeBase());
  try { saved = JSON.parse(sessionStorage.getItem(storageKey)); } catch {}
  const query = new URLSearchParams(location.search), task = query.get('task');
  if (task && /^(?:[1-9]\d*|n[1-9]\d*:[1-9]\d*)$/.test(task)) {
    requestedTask = task.startsWith('n') ? task : Number(task);
    query.delete('task'); history.replaceState(null, '', location.pathname + (query.size ? '?' + query : ''));
  }
  document.addEventListener("pointerdown", cancelRestore, true);
  document.addEventListener("keydown", cancelRestore, true);
  window.addEventListener("pagehide", remember);
  document.addEventListener("visibilitychange", () => { if (document.hidden) remember(); });

  panel = element("div", "cloud-device-panel");
  panel.append(element("div", "cloud-device-heading"));
  list = element("div", "cloud-device-list"); panel.append(list);
  advanced = element("details", "cloud-advanced");
  advanced.append(element("summary"), element("p"));
  hostList = element("div", "cloud-host-list"); advanced.append(hostList);
  const add = element("button", "cloud-menu-action cloud-add-ssh"); add.type = "button";
  add.onclick = () => { switcher.open = false; window.openDiscoveryModal(); };
  advanced.append(add); panel.append(advanced); switcher.append(panel);
  const manage = element('a', 'cloud-menu-action'); manage.href = cloudOrigin + '/devices'; manage.dataset.themeLink = '';
  manage.textContent = I18N.lang === 'zh' ? '设备接入与配置' : 'Device settings';
  if (direct) {
    // Account management requires the cloud browser session. Keep local PTYs
    // open rather than passing account authority into a device credential.
    manage.target = '_blank'; manage.rel = 'noopener';
    manage.title = I18N.lang === 'zh' ? '在云端打开设备设置，当前工作保持不变' : 'Open cloud settings; keep this workspace running';
    manage.textContent += ' ↗';
    manage.onclick = () => { switcher.open = false; };
  } else {
    let manager;
    manage.onclick = async event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); switcher.open = false;
      try {
        manager ||= import('../../cloud/device-manager.js').then(({ createDeviceManager }) => createDeviceManager(switcher.dataset.userId, {
          onDevices(items) { devices = items; renderDevices(); repaintCurrent(); },
          onEnter(url, id) {
            if (id === switcher.dataset.deviceId) { manager.then(m => m.close()); return; }
            location.assign(Theme.url(url));
          },
        }));
        (await manager).open();
      } catch { manager = null; window.open(Theme.url(manage.href), '_blank', 'noopener'); }
    };
  }
  panel.append(manage);
  panel.addEventListener("click", remember, true);
  panel.addEventListener("auxclick", remember, true);
  switcher.addEventListener("toggle", () => { if (switcher.open) refreshDevices(true); });
  document.addEventListener("click", event => { if (!switcher.contains(event.target)) switcher.open = false; });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !switcher.open) return;
    event.preventDefault(); event.stopPropagation(); switcher.open = false; switcher.querySelector("summary").focus();
  }, true);
  repaintCloudWorkspace(); refreshDevices(true);
  setInterval(() => { if (!document.hidden && !switcher.open) refreshDevices(); }, 15000);
  if (direct) watchLocalSession(switcher.dataset.deviceId, () => {
    remember();
    const task = validTask(state.selectedTaskId) ? '?task=' + encodeURIComponent(state.selectedTaskId) : '';
    location.replace(Theme.url(withView('/local/open' + task, new URLSearchParams(location.search).get('view'))));
  });
}

// Only re-attach a still-live task belonging to this user, node and host. Never
// resume an archived task or let a slow fleet request override a user's click.
export async function restoreCloudWorkspace(firstFleet) {
  if (!switcher) return;
  try {
    if (requestedTask != null && localHost()) {
      const remote = typeof requestedTask === 'string' && /^n(\d+):/.exec(requestedTask);
      saved = { schema_version: 1, host_id: remote ? Number(remote[1]) : localHost().id, task_id: requestedTask, terminal_view: true };
      requestedTask = null;
    }
    if (restoreCancelled || saved?.schema_version !== 1 || !Number.isSafeInteger(saved.host_id)) return;
    const host = state.hostsById[saved.host_id];
    if (!host) return;
    if (host.kind !== "local") await firstFleet;
    if (restoreCancelled || state.selectedTaskId != null || !state.hostsById[host.id]) return;
    hooks.selectHost(host.id, { follow: false });
    let attach;
    if (host.kind === "local") {
      const task = hooks.allTasks().find(t => t.id === saved.task_id);
      const owner = task && (task.host_id ?? state.repos.find(r => r.id === task.repo_id)?.host_id);
      if (task?.alive && task.status !== "cleaned" && Number(owner) === host.id) attach = () => hooks.connect(task.id);
    } else {
      const fleet = state.fleet[host.id], match = typeof saved.task_id === "string" && /^n(\d+):(\d+)$/.exec(saved.task_id);
      const task = match && Number(match[1]) === host.id && fleet?.tasks?.find(t => t.id === Number(match[2]));
      if (fleet?.ok && !fleet.needsUpdate && task && (task.alive ?? true) && task.status !== "cleaned") attach = () => hooks.connectNode(host.id, task.id);
    }
    if (attach) {
      if (saved.terminal_view) attach(); else duringAutoFollow(attach);
    }
    if (Number.isFinite(saved.scroll_top) && saved.scroll_top >= 0) $("m-list").scrollTop = saved.scroll_top;
  } finally {
    canRemember = !!localHost();
    document.removeEventListener("pointerdown", cancelRestore, true);
    document.removeEventListener("keydown", cancelRestore, true);
  }
}
