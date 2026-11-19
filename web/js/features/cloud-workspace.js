import { $, nodeBase } from "../core/dom.js";
import { state } from "../core/state.js";
import { duringAutoFollow } from "./mobile.js";

let switcher, panel, list, advanced, hostList, hooks;
let devices = [], loading = false, failure = "", expired = false, pending;
let storageKey = "", saved, canRemember = false, restoreCancelled = false, hostSignature = "";
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
  list.replaceChildren();
  list.setAttribute("aria-busy", String(loading));
  if (loading) {
    const status = element("div", "cloud-device-message");
    status.setAttribute("role", "status");
    status.append(element("span", "spinner"), element("span", "", text("loading")));
    list.append(status);
    return;
  }
  if (failure) {
    const status = element("div", "cloud-device-message", failure);
    status.setAttribute("role", "status");
    const retry = element(expired ? "a" : "button", "cloud-menu-action", text(expired ? "expired" : "retry"));
    if (expired) retry.href = "/";
    else { retry.type = "button"; retry.onclick = () => refreshDevices(true); }
    list.append(status, retry);
    return;
  }
  for (const device of devices) {
    const current = device.id === switcher.dataset.deviceId;
    const row = element("a", "cloud-device-option" + (current ? " current" : ""));
    row.dataset.deviceId = device.id;
    if (device.online) row.href = "/workspace/" + encodeURIComponent(device.id) + "/";
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
}

async function refreshDevices(showLoading = false) {
  if (pending) return pending;
  if (showLoading) { loading = true; renderDevices(); }
  pending = (async () => {
    try {
      const response = await fetch("/hub/devices", { signal: AbortSignal.timeout(10000) });
      if (!response.ok) { expired = response.status === 401; throw new Error("devices unavailable"); }
      const result = await response.json();
      if (!Array.isArray(result.items)) throw new Error("invalid devices");
      devices = result.items; failure = ""; expired = false;
    } catch {
      devices = []; failure = text(expired ? "expired" : "failed");
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
  panel.querySelector(".cloud-manage").textContent = text("manage") + " ↗";
  advanced.querySelector("summary").textContent = text("advanced");
  advanced.querySelector("p").textContent = text("sshNote");
  advanced.querySelector(".cloud-add-ssh").textContent = text("addSsh");
  if (failure) failure = text(expired ? "expired" : "failed");
  renderDevices(); refreshCloudHosts();
}

export function initCloudWorkspace(callbacks) {
  switcher = $("cloud-device-switcher");
  if (!switcher || !nodeBase()) { switcher = null; return; }
  hooks = callbacks;
  storageKey = "switchyard-workspace:" + switcher.dataset.userId + ":" + nodeBase();
  try { saved = JSON.parse(sessionStorage.getItem(storageKey)); } catch {}
  document.addEventListener("pointerdown", cancelRestore, true);
  document.addEventListener("keydown", cancelRestore, true);
  window.addEventListener("pagehide", remember);
  document.addEventListener("visibilitychange", () => { if (document.hidden) remember(); });

  panel = element("div", "cloud-device-panel");
  panel.append(element("div", "cloud-device-heading"));
  list = element("div", "cloud-device-list"); panel.append(list);
  const manage = element("a", "cloud-menu-action cloud-manage"); manage.href = "/";
  panel.append(manage);
  advanced = element("details", "cloud-advanced");
  advanced.append(element("summary"), element("p"));
  hostList = element("div", "cloud-host-list"); advanced.append(hostList);
  const add = element("button", "cloud-menu-action cloud-add-ssh"); add.type = "button";
  add.onclick = () => { switcher.open = false; window.openDiscoveryModal(); };
  advanced.append(add); panel.append(advanced); switcher.append(panel);
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
}

// Only re-attach a still-live task belonging to this user, node and host. Never
// resume an archived task or let a slow fleet request override a user's click.
export async function restoreCloudWorkspace(firstFleet) {
  if (!switcher) return;
  try {
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
