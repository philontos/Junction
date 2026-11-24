import { agentCatalog, agentName, canShareAgent, loadAgentCatalog, requireAgent } from "../core/agents.js";
import { $, api, nodePath } from "../core/dom.js";
import { requireDirectoryTasks, matchingWorkspaceRepo } from "../core/directory-tasks.js";
import { createReferencePicker } from "../core/reference-picker.js";
import { state } from "../core/state.js";
import { reconcileChildren } from "../core/keyed-list.js";
import { toast } from "../core/feedback.js";
import { readShareStream } from "./junction-stream.js";
import { createContextReader } from "./junction-reader.js";

const L = (zh, en) => I18N.lang === "zh" ? zh : en;
let hooks, status, listCursor, generation = 0, listRequest = 0, activeShare = null, shareDismissTimer;
let selectedContext = null, launchingContext = false, connectingJunction = false;
let listController, listItems = [], listReady = false, listScope = 'all';
let settings = {};
let continuationReferences;
const call = (url, options = {}) => settings.request ? settings.request(url, options) : api("/api/junction" + url, options);
const send = (url, body, method = "POST") => call(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const base = meta => `/contexts/${meta.id}/revisions/${meta.revision.id}`;
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function button(text, fn, cls = "sec") { const b = el("button", text, cls); b.type = "button"; b.onclick = async () => { b.disabled = true; try { await fn(); } catch(e) { showError(e); } finally { b.disabled = false; } }; return b; }
const contextDialogIsOpen = () => !$("jx-task-modal").hidden;
function showError(e, id = contextDialogIsOpen() ? "jx-task-error" : "jx-error") { $(id).textContent = e.message || String(e); $(id).hidden = false; }
function clearError(id = contextDialogIsOpen() ? "jx-task-error" : "jx-error") { $(id).hidden = true; }
function field(label, input) { const f = el("label", undefined, "jx-field"); f.append(el("span", label), input); return f; }
function textInput(value = "", placeholder = "") { const input = el("input"); input.value = value; input.placeholder = placeholder; return input; }
function note(text) { return el("p", text, "jx-note"); }
const contextOwner = meta => meta.owner_name || meta.owner_id || L("未记录", "Not recorded");
function contextCopy(meta) {
  const overview = meta.revision.normalized?.extensions?.["junction.overview/1"];
  return { title: overview?.title || meta.title, summary: overview?.summary || "" };
}
function saveCardCache() {
  if (!settings.cacheKey) return;
  // Only card summaries survive document navigation. Conversation, environment
  // details and credentials are never stored here; opening a cached card reads
  // its pinned revision again through the current account's authorization.
  const items = listItems.map(meta => {
    const r = meta.revision, copy = contextCopy(meta), ext = r.normalized?.extensions || {};
    const workspace = ext['switchyard.workspace/1'] || ext['switchyard.capture/1'];
    return { id: meta.id, title: meta.title, owner_id: meta.owner_id, owner_name: meta.owner_name, _cached: true,
      revision: { id: r.id, number: r.number, provider: r.provider, created_at: r.created_at,
        normalized: { extensions: { 'junction.overview/1': copy, 'switchyard.workspace/1': { repo_name: workspace?.repo_name, branch: workspace?.branch } } } } };
  });
  try {
    const value = JSON.stringify({ at: Date.now(), items, cursor: listCursor });
    if (value.length < 500000) sessionStorage.setItem(settings.cacheKey, value);
  } catch { /* Caching is optional in storage-restricted browsers. */ }
}
function cardFact(kind, text) {
  const fact = el("span", undefined, `jx-card-fact jx-card-${kind}`);
  const icon = el("span", undefined, `jx-fact-icon jx-icon-${kind}`); icon.setAttribute("aria-hidden", "true");
  fact.title = kind === "owner" ? `${L("共享者", "Shared by")}: ${text}` : text;
  fact.append(icon, el("span", text)); return fact;
}
function setDialogInert(open) {
  if (!settings.mount) return;
  document.querySelector('body > header').inert = open;
  document.querySelector('.primary-nav').inert = open;
  document.body.classList.toggle('context-dialog-open', open);
  const workbench = document.querySelector('.workspace-surfaces > .wrap');
  if (workbench) workbench.inert = open || workbench.parentElement.dataset.view !== 'workbench';
}
function closeContextDialog(restoreFocus = true) {
  if (launchingContext || connectingJunction) return false;
  if (!contextDialogIsOpen()) return true;
  ++generation;
  continuationReferences?.dispose(); continuationReferences = null;
  $("jx-task-modal").hidden = true;
  setDialogInert(false);
  $("junction-modal").inert = false;
  $("junction-modal").removeAttribute("aria-hidden");
  $("jx-detail").replaceChildren(); $("jx-task-submit-slot").replaceChildren();
  if (restoreFocus) {
    const card = [...$("jx-list").querySelectorAll(".jx-card")].find(b => b.dataset.contextId === selectedContext?.cid);
    (card || ($("junction-modal").hidden ? $("junction-nav") : $("jx-refresh")))?.focus({ preventScroll: true });
  }
  return true;
}
function detailRoot(title = L("新建任务", "New task")) {
  continuationReferences?.dispose(); continuationReferences = null;
  const opening = !contextDialogIsOpen();
  $("jx-task-modal").dataset.view = "task";
  $("jx-task-heading").textContent = title;
  $("jx-task-modal").hidden = false;
  setDialogInert(true);
  if (opening) $("jx-task-close").focus({ preventScroll: true });
  $("junction-modal").inert = true;
  $("junction-modal").setAttribute("aria-hidden", "true");
  clearError("jx-task-error");
  $("jx-task-submit-slot").replaceChildren();
  $("jx-task-navigation").replaceChildren(); $("jx-task-navigation").hidden = true;
  const d = $("jx-detail"); d.replaceChildren(); return d;
}
export function closeJunction() {
  if (!closeContextDialog(false)) return;
  if (settings.mount) return;
  $("junction-modal").hidden = true;
  generation++; listRequest++; listController?.abort();
}
export function junctionIsOpen() { return contextDialogIsOpen() || (!settings.mount && !$("junction-modal").hidden); }
export function refreshJunction() {
  // A background warm-up must never dismiss a preview or continuation form.
  $("junction-modal").hidden = false;
  return loadList();
}
export async function openJunction(taskId = null) {
  if (taskId) return shareTask(taskId);
  if (!closeContextDialog(false)) return;
  ++generation;
  selectedContext = null;
  $("jx-detail").replaceChildren();
  if (!listReady) $("jx-search").value = "";
  // A first visit starts with loading. Later visits keep the existing cards
  // visible while refreshing, without reintroducing a modal loading overlay.
  const loading = loadList();
  $("junction-modal").hidden = false;
  return loading;
}
export async function openPinnedContext(reference) {
  const epoch = ++generation, d = detailRoot(L('继续任务', 'Continue task'));
  selectedContext = { cid: reference.context, rid: reference.revision };
  d.append(note(L('正在读取此版本…', 'Loading this revision…')));
  try {
    const [meta, currentStatus] = await Promise.all([
      call(`/contexts/${reference.context}/revisions/${reference.revision}`), call('/status'), loadAgentCatalog(),
    ]);
    if (epoch !== generation) return false;
    status = currentStatus;
    openDetail(meta, "task");
    return true;
  } catch (error) {
    if (epoch === generation) { d.replaceChildren(button(L('重新读取', 'Retry'), () => openPinnedContext(reference))); showError(error); }
    return false;
  }
}
async function showConnection(known) {
  const epoch = ++generation;
  selectedContext = null;
  const d = detailRoot(L("连接 Junction", "Connect Junction"));
  $("jx-task-modal").dataset.view = "connection";
  d.append(note(L("读取连接信息…", "Loading connection…")));
  try {
    const info = known || await call("/connection");
    if (epoch !== generation) return;
    d.replaceChildren();
    const form = el("form", undefined, "jx-connect-form");
    const url = textInput(info.url, "https://junction.example.com"); url.id = "jx-connect-url";
    url.type = "url"; url.required = true; url.autocomplete = "url"; url.spellcheck = false;
    const token = textInput("", L("粘贴设备凭证", "Paste device credential"));
    token.id = "jx-connect-token"; token.type = "password"; token.required = true; token.maxLength = 256;
    token.autocomplete = "off"; token.spellcheck = false;
    const node = textInput(info.node_id); node.id = "jx-connect-node"; node.readOnly = true;
    node.onclick = () => node.select();
    form.append(field(L("服务地址", "Service URL"), url), field(L("设备凭证", "Device credential"), token),
      field(L("当前设备 ID", "This device ID"), node));
    const enter = el("button"); enter.type = "submit"; enter.hidden = true; form.append(enter);
    d.append(form);
    if (info.error) d.append(note(info.error));
    const submit = button(L("验证并连接", "Verify and connect"), async () => {
      if (!form.reportValidity() || connectingJunction) return;
      clearError();
      connectingJunction = true;
      $("jx-task-close").disabled = $("jx-task-cancel").disabled = true;
      submit.textContent = L("正在连接…", "Connecting…");
      try {
        const result = await send("/connection", { url: url.value.trim(), token: token.value.trim() });
        token.value = "";
        connectingJunction = false;
        closeContextDialog();
        toast(L("已连接 Junction · ", "Connected to Junction · ") + result.user_id);
        listReady = false; listItems = []; listCursor = null;
        await openJunction();
      } finally {
        connectingJunction = false;
        $("jx-task-close").disabled = $("jx-task-cancel").disabled = false;
        submit.textContent = L("验证并连接", "Verify and connect");
      }
    }, "primary");
    form.onsubmit = e => { e.preventDefault(); submit.click(); };
    $("jx-task-submit-slot").append(submit);
    url.focus({ preventScroll: true });
  } catch (e) { if (epoch === generation) showError(e); }
}
function renderContextList() {
  if (!listReady) return;
  const normalize = value => String(value || "").normalize("NFKC").toLowerCase();
  const terms = normalize($("jx-search").value).trim().split(/\s+/).filter(Boolean);
  const matches = listItems.filter(item => {
    if (listScope === 'mine' && item.owner_id !== settings.userId) return false;
    const text = normalize([contextCopy(item).title, item.title, item.owner_name, item.owner_id].join(" "));
    return terms.every(term => text.includes(term));
  });
  const list = $("jx-list"), cards = [];
  const existing = new Map([...list.children].map(card => [card.dataset.contextId, card]));
  for (const item of matches) {
    const r = item.revision, workspace = r.normalized?.extensions?.["switchyard.workspace/1"] || r.normalized?.extensions?.["switchyard.capture/1"];
    const copy = contextCopy(item);
    const version = JSON.stringify([I18N.lang, r.id, copy, r.provider, contextOwner(item), workspace?.repo_name, workspace?.branch]);
    const previous = existing.get(item.id);
    if (previous?.dataset.version === version) { previous.querySelector('.jx-card').contextMeta = item; cards.push(previous); continue; }
    const group = el("div", undefined, "jx-context-card");
    group.dataset.contextId = item.id; group.dataset.version = version;
    const card = button("", () => openDetail(card.contextMeta), "jx-card"); card.contextMeta = item;
    card.dataset.contextId = item.id;
    card.setAttribute("aria-label", `${L("预览并接续", "Preview and continue")}: ${copy.title}`);
    const heading = el("span", undefined, "jx-card-heading"), title = el("strong", copy.title);
    title.title = copy.title;
    const agent = el("span", agentName(r.provider), "jx-card-agent"); agent.dataset.agent = r.provider;
    agent.title = agentName(r.provider);
    heading.append(title, agent); card.append(heading);
    card.append(el("span", copy.summary || L("暂无任务摘要", "No task summary yet"), "jx-card-summary"));
    const footer = el("span", undefined, "jx-card-footer");
    footer.append(cardFact("repo", workspace?.repo_name || L("仓库未记录", "Repository not recorded")),
      cardFact("branch", workspace?.branch || L("分支未记录", "Branch not recorded")),
      cardFact("owner", contextOwner(item)));
    card.append(footer); group.append(card);
    cards.push(group);
    if (listReady) window.PageLoad.fade(group);
  }
  if (!matches.length) {
    const empty = el("div", undefined, "jx-empty");
    empty.append(el("p", terms.length ? L("未找到匹配的 Context", "No matching contexts") : listScope === 'mine' ? L("你还没有共享 Context", "You haven't shared a context yet") : L("还没有共享的 Context", "No shared contexts yet")));
    if (!terms.length) empty.append(note(L("在工作台完成一段工作后，点击「共享」即可保存在这里。", "Use Share in the workbench to save your work here.")));
    if (terms.length && listCursor) empty.append(note(L("可加载更多，或换个关键词。", "Load more, or try another search.")));
    cards.push(empty);
  }
  reconcileChildren(list, cards);
  const count = $("jx-count");
  count.textContent = terms.length || listScope !== 'all' ? `${matches.length} / ${listItems.length}` : `${listItems.length} ${listCursor ? L("已加载", "loaded") : L("个", "contexts")}`;
  count.title = terms.length ? L("匹配数 / 已加载数", "Matches / loaded contexts") : L("已加载的 Context", "Loaded contexts");
  count.setAttribute("aria-label", L(`已加载 ${listItems.length} 个 Context，匹配 ${matches.length} 个`, `${listItems.length} contexts loaded, ${matches.length} matches`));
}
async function loadList(append = false) {
  if (append && !listCursor) return;
  listController?.abort();
  const controller = new AbortController(); listController = controller;
  const request = ++listRequest, list = $("jx-list"), options = { signal: controller.signal };
  const cursor = append ? listCursor : null;
  const initial = !listReady;
  clearError("jx-error");
  list.setAttribute("aria-busy", "true");
  $("jx-refresh").disabled = $("jx-more").disabled = true;
  if (!append && initial) {
    listReady = false; listItems = []; listCursor = null;
    $("jx-more").hidden = true; $("jx-count").textContent = "";
    $("jx-count").removeAttribute("aria-label"); $("jx-count").removeAttribute("title");
    $("jx-search").disabled = $("jx-connect").disabled = true;
    $("jx-library").inert = true; $("jx-library").scrollTop = 0;
    $("jx-library-loading").setAttribute("aria-hidden", "false");
    $("jx-library").parentElement.dataset.loading = "true";
    list.replaceChildren();
  } else if (append) {
    const spinner = el("span", undefined, "spinner"); spinner.setAttribute("aria-hidden", "true");
    $("jx-more").replaceChildren(spinner, document.createTextNode(L("加载中…", "Loading…")));
  }
  try {
    if (!append && !settings.continueContext) {
      const connection = await call("/connection", options);
      if (request !== listRequest) return;
      if (!connection.configured) {
        listReady = false; listItems = []; listCursor = null; list.replaceChildren();
        list.append(button(L("连接 Junction", "Connect Junction"), () => showConnection(), "jx-empty sec"));
        return settings.mount ? undefined : showConnection(connection);
      }
    }
    const [page, currentStatus] = await Promise.all([
      call("/contexts" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""), options),
      append || settings.continueContext ? status : call("/status", options),
      settings.continueContext ? null : loadAgentCatalog(),
    ]);
    if (request !== listRequest) return;
    status = currentStatus;
    listItems = [...new Map([...(append ? listItems : []), ...page.items].map(item => [item.id, item])).values()];
    listCursor = page.next_cursor; listReady = true;
    saveCardCache();
    renderContextList();
    $("jx-more").hidden = !listCursor;
  } catch (e) {
    if (request !== listRequest) return;
    controller.abort();
    if ([401, 403].includes(e.status)) {
      listReady = false; listItems = []; listCursor = null;
      try { if (settings.cacheKey) sessionStorage.removeItem(settings.cacheKey); } catch {}
    }
    if (!listReady) list.replaceChildren(button(L("重新加载", "Retry"), () => loadList()));
    if (settings.mount || junctionIsOpen()) showError(e, "jx-error");
  } finally {
    if (request === listRequest) {
      list.setAttribute("aria-busy", "false");
      $("jx-refresh").disabled = $("jx-connect").disabled = $("jx-more").disabled = false;
      $("jx-search").disabled = !listReady;
      $("jx-more").textContent = L("加载更多", "Load more");
      $("jx-library").inert = false;
      $("jx-library-loading").setAttribute("aria-hidden", "true");
      $("jx-library").parentElement.dataset.loading = "false";
    }
  }
}
function versionList(item) {
  const details = el("details", undefined, "jx-versions jx-section");
  details.append(el("summary", L("版本记录", "Versions")));
  const panel = el("div", undefined, "jx-version-panel"), rows = el("div"), controls = el("div");
  panel.setAttribute("aria-label", `${item.title} · ${L("版本记录", "Versions")}`);
  panel.append(rows, controls); details.append(panel);
  let loaded = false, loading = false, cursor = null;
  const load = async (more = false) => {
    if (loading) return;
    loading = true;
    controls.replaceChildren(note(L("读取中…", "Loading…")));
    try {
      const q = more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = await call(`/contexts/${item.id}/revisions${q}`);
      if (!details.isConnected) return;
      if (!more) rows.replaceChildren();
      for (const revision of page.items) {
        const b = button("", () => openDetail({ ...item, revision }), "jx-version");
        b.dataset.revisionId = revision.id;
        b.append(el("span", `v${revision.number}${revision.id === item.revision.id ? L(" · 当前", " · Current") : ""}`),
          el("span", new Date(revision.created_at).toLocaleString(), "jx-meta"));
        rows.append(b);
      }
      loaded = true; cursor = page.next_cursor; controls.replaceChildren();
      if (!rows.children.length) controls.append(note(L("暂无版本记录", "No versions yet")));
      if (cursor) controls.append(button(L("更多版本", "More versions"), () => load(true)));
    } catch (e) {
      if (details.isConnected) controls.replaceChildren(note(e.message), button(L("重试", "Retry"), () => load(more)));
    } finally { loading = false; }
  };
  details.ontoggle = () => {
    if (details.open && !loaded) load();
  };
  return details;
}
async function openDetail(meta, initialMode = "reader") {
  if (launchingContext) return;
  if (meta._cached) {
    const epoch = ++generation, d = detailRoot(L('Context 预览', 'Context preview'));
    selectedContext = { cid: meta.id, rid: meta.revision.id };
    d.append(el('h3', contextCopy(meta).title), note(L('正在读取此版本…', 'Loading this revision…')));
    try { const current = await call(base(meta)); if (epoch === generation) return openDetail(current, initialMode); }
    catch (error) { if (epoch === generation) showError(error); }
    return;
  }
  const epoch = ++generation;
  selectedContext = { cid: meta.id, rid: meta.revision.id };
  // Lists already carry the complete revision header. Render it in one frame;
  // a loading-only dialog used to collapse, then grow when the same data arrived.
  // History stays lazy, and continuation/export still check access on the server.
  const cid = meta.id, rid = meta.revision.id;
  const r = meta.revision, w = r.normalized.extensions?.["switchyard.workspace/1"];
  const copy = contextCopy(meta);
  const d = detailRoot();
  const source = el("div", undefined, "jx-task-source");
  source.append(el("span", L("来源 Context", "Source context"), "jx-meta"), el("strong", copy.title));
  if (copy.summary) source.append(el("p", copy.summary, "jx-source-summary"));
  source.append(el("span", `${L("共享者", "Shared by")}: ${contextOwner(meta)} · v${r.number} · ${agentName(r.provider)}${w ? ` · ${w.repo_name} / ${w.branch}` : ""}`, "jx-meta"));
  d.append(source);
  d.append(el("div", undefined, "jx-continuation"));
  $("jx-task-modal").dataset.view = "context";
  const reader = createContextReader(meta, { request: path => call(base(meta) + path), valid: () => epoch === generation });
  reader.element.hidden = true; d.append(reader.element);
  const navigation = $("jx-task-navigation");
  const continuation = d.querySelector(".jx-continuation");
  const proceed = button(L("继续此任务", "Continue this task"), () => setMode("task"), "primary");
  proceed.id = "jx-context-continue";
  proceed.disabled = r.status === "failed";
  if (proceed.disabled) proceed.title = L("记录解析失败，暂时无法接续。", "This record could not be parsed and cannot be continued.");
  $("jx-task-submit-slot").append(proceed);
  const back = button(L("← 返回预览", "← Back to preview"), () => setMode("reader"), "");
  navigation.append(back);
  const positions = { task: 0, reader: 0 }; let currentMode = "reader", continuationReady = false;
  function setMode(mode) {
    if (launchingContext) return;
    positions[currentMode] = d.scrollTop; currentMode = mode;
    continuation.hidden = mode !== "task"; reader.element.hidden = mode !== "reader";
    if (mode === "task" && !continuationReady) {
      continuationReady = true;
      if (settings.continueContext) settings.continueContext(meta, continuation, $("jx-task-submit-slot"), () => epoch === generation);
      else showContinue(meta);
    }
    const submit = $("jx-task-submit");
    if (submit) submit.hidden = mode !== "task";
    proceed.hidden = mode !== "reader";
    navigation.hidden = mode !== "task";
    $("jx-task-heading").textContent = mode === "reader" ? L("Context 预览", "Context preview") : settings.continueContext ? L("选择执行设备", "Choose a device") : L("新建任务", "New task");
    d.scrollTop = positions[mode];
    if (mode === "reader") reader.activate();
    // The preview tabs never replace the footer or reset a task draft. Only the
    // explicit continuation action enters setup, within this same pinned record.
    if (navigation.contains(document.activeElement) && mode === "reader") proceed.focus({ preventScroll: true });
    else if (document.activeElement === proceed && mode === "task") back.focus({ preventScroll: true });
  }
  const details = el("section", undefined, "jx-context-information");
  details.append(el("h3", L("记录信息", "Record information")));
  details.append(note(`${new Date(r.created_at).toLocaleString()} · v${r.number} · ${agentName(r.provider)}`));
  const overview = r.normalized.extensions?.["junction.overview/1"];
  if (overview?.description) details.append(el("p", overview.description, "jx-note jx-description"));
  const capture = r.normalized.extensions?.["switchyard.capture/1"];
  if (capture?.notes) for (const item of capture.notes) details.append(note(item.detail));
  if (w) details.append(note(`${L("代码版本", "Commit")}: ${w.commit}`));
  details.append(note(L("保留原始记录和标准化历史。工具、附件和权限由当前设备提供。", "Original and normalized records are retained. Tools, attachments and permissions come from the current device.")));
  const actions = el("div", undefined, "jx-actions");
  actions.append(button(L("下载 Context", "Export context"), async () => {
    const data = await call(base(meta) + "/export");
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = el("a"); a.href = url; a.download = `context-${rid}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
  if (w?.source) {
    const local = w.source.node_id === status?.node_id;
    const host = Object.values(state.hostsById).find(h => h.node_id === w.source.node_id && h.kind !== "local");
    if (local || host) actions.append(button(L("进入原任务", "Open source task"), async () => {
      if (local) {
        await hooks.loadTasks();
        if (!hooks.allTasks().some(t => t.id === w.source.task_id)) throw new Error(L("原任务已移除，仍可通过快照接续。", "The source task was removed; continue from this snapshot instead."));
        closeJunction(); settings.showWorkbench?.(); hooks.connect(w.source.task_id);
      } else {
        await hooks.loadFleet();
        if (!state.fleet[host.id]?.tasks?.some(t => t.id === w.source.task_id)) throw new Error(L("原设备离线或原任务不可用，仍可拉取这份 Context。", "Source device or task unavailable. This context remains readable."));
        closeJunction(); settings.showWorkbench?.(); hooks.connectNode(host.id, w.source.task_id);
      }
    }));
  }
  details.append(actions);
  reader.info.append(details, versionList(meta));
  const identity = el("details", undefined, "jx-section");
  identity.append(el("summary", L("记录标识", "Record identifiers")), el("code", `${cid} / ${rid}`, "jx-ids")); reader.info.append(identity);
  if (r.diagnostic_count) {
    const diagnostics = el("details", undefined, "jx-section");
    diagnostics.append(el("summary", `${L("解析说明", "Parsing notes")} · ${r.diagnostic_count}`)); reader.info.append(diagnostics);
    let loaded = false, loading = false;
    diagnostics.ontoggle = async () => {
      if (!diagnostics.open || loaded || loading) return;
      loading = true;
      try {
        const page = await call(base(meta) + "/diagnostics?limit=100");
        if (epoch !== generation) return;
        for (const item of page.items) diagnostics.append(note(item.detail));
        loaded = true;
      } catch (e) { if (epoch === generation) showError(e); }
      finally { loading = false; }
    };
  }
  setMode(initialMode);
}
function showContinue(meta) {
  const target = $("jx-detail").querySelector(".jx-continuation"); target.replaceChildren();
  if (meta.revision.status === "failed") { target.append(note(L("记录解析失败，暂时无法接续。请查看详细信息。", "This record could not be parsed. Review the details before continuing."))); return; }
  const w = meta.revision.normalized.extensions?.["switchyard.workspace/1"];
  const hint = w || meta.revision.normalized.extensions?.["switchyard.capture/1"];
  // The executing node owns repository matching and managed directory allocation.
  // A handoff never needs the user to choose a path or reuse the source cwd.
  const automaticRepo = typeof hint?.repo_url === "string" && !!hint.repo_url.trim();
  let agent = agentCatalog().some(a => a.id === meta.revision.provider) ? meta.revision.provider : "claude";
  const agents = el("div", undefined, "agent-seg"); agents.setAttribute("role", "group"); agents.setAttribute("aria-label", "Agent");
  for (const { id: value, name: label } of agentCatalog()) {
    const b = el("button", label, "agent-opt"); b.type = "button"; b.dataset.agent = value;
    b.classList.toggle("selected", value === agent); b.setAttribute("aria-pressed", String(value === agent));
    b.onclick = () => {
      agent = value;
      for (const option of agents.children) {
        const selected = option.dataset.agent === agent;
        option.classList.toggle("selected", selected); option.setAttribute("aria-pressed", String(selected));
      }
    };
    agents.append(b);
  }
  const title = textInput(`${L("接续", "Continue")}: ${contextCopy(meta).title}`.slice(0, 200)); title.maxLength = 200; title.required = true;
  const prompt = el("textarea"); prompt.rows = 2; prompt.maxLength = 8000; prompt.placeholder = L("接下来要做什么？留空则按 Context 继续。", "What should the agent do next? Leave blank to continue from the context.");
  const model = textInput("", L("默认模型", "Default model")); model.maxLength = 100;
  const form = el("form", undefined, "jx-form"); form.id = "jx-task-form";
  const fields = el("fieldset"); form.append(fields);
  const agentField = el("div", undefined, "jx-field"); agentField.append(el("span", "Agent"), agents);
  fields.append(agentField, field(L("任务标题", "Task title"), title), field(L("补充要求（可选）", "Instructions (optional)"), prompt));
  const refs = el("div", undefined, "tm-ref-sec"); refs.id = "jx-task-references";
  const refHead = el("div", undefined, "tm-ref-head");
  const refAdd = el("button", I18N.t("task.addReference"), "tm-ref-add"); refAdd.type = "button";
  refHead.append(el("span", I18N.t("task.referencesLabel"), "tm-lbl"), refAdd);
  refs.append(refHead, el("div", undefined, "tm-ref-list"), el("div", undefined, "hint"));
  fields.append(refs);
  let referenceRepos = [];
  const picker = continuationReferences = createReferencePicker({ root: () => refs,
    catalog: () => referenceRepos.filter(repo => repo.status === "ready" && !matchingWorkspaceRepo([repo], hint?.repo_url)),
    loadBranches: (id, signal) => api(`/api/repos/${id}/branches`, { signal }),
  });
  picker.render();
  api("/api/repos").then(repos => {
    if (continuationReferences !== picker) return;
    referenceRepos = repos; picker.render();
  }).catch(error => { if (continuationReferences === picker) showError(error); });
  const options = el("details", undefined, "jx-section"); options.append(el("summary", L("更多设置", "More options")));
  options.append(field(L("模型", "Model"), model));
  fields.append(options);
  if (automaticRepo && !hint.commit) fields.append(note(hint.branch && hint.branch !== "HEAD"
    ? L(`未记录提交号，将使用 ${hint.branch} 分支的当前版本。`, `No commit recorded; use the current ${hint.branch} branch.`)
    : L("未记录代码版本，将使用仓库默认分支。", "No revision recorded; use the repository's default branch.")));
  if (!automaticRepo && (hint?.repo_name || hint?.commit || hint?.branch)) fields.append(note(L("未记录仓库地址，将在独立任务中加载历史，代码需要重新准备。", "No repository address recorded. History will open in an independent task; code must be prepared separately.")));
  if (hint?.dirty) fields.append(el("p", L("来源的未提交修改未包含在 Context 中。", "Uncommitted source changes are not included."), "jx-warning"));
  if (meta.revision.status !== "ready") fields.append(note(L("部分历史内容或关联无法确认，Agent 会先检查记录与当前代码。", "Some history or relationships could not be confirmed. The agent will check the records and current code first.")));
  const submit = el("button", L("创建任务", "Create task"), "primary"); submit.type = "submit"; submit.id = "jx-task-submit"; submit.setAttribute("form", form.id);
  const preparation = el("div", undefined, "jx-preparation"); preparation.hidden = true;
  preparation.setAttribute("role", "status"); preparation.setAttribute("aria-live", "polite");
  const progressLabel = el("span"); progressLabel.id = "jx-prepare-label";
  const progressBar = el("progress"); progressBar.max = 6; progressBar.value = 0;
  progressBar.setAttribute("aria-labelledby", progressLabel.id);
  preparation.append(progressLabel, progressBar); form.append(preparation);
  const stages = { context: [1, "读取 Context…", "Reading context…"], repository: [2, "准备仓库…", "Preparing repository…"],
    fetch: [3, "拉取代码版本…", "Fetching code…"], worktree: [4, "创建工作区…", "Creating workspace…"], agent: [5, "启动 Agent…", "Starting agent…"] };
  const updateProgress = event => {
    const stage = stages[event.stage]; if (!stage) return;
    progressBar.value = Math.max(progressBar.value, stage[0]);
    progressLabel.textContent = L(event.message || stage[1], stage[2]);
  };
  $("jx-task-submit-slot").append(submit);
  const setBusy = busy => {
    launchingContext = busy; fields.disabled = busy; submit.disabled = busy;
    $("jx-task-close").disabled = busy; $("jx-task-cancel").disabled = busy;
    for (const button of $("jx-task-navigation").querySelectorAll("button")) button.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    preparation.hidden = !busy;
    if (busy) { progressBar.value = 0; progressLabel.textContent = L("正在检查 Agent…", "Checking agent…"); }
    submit.textContent = busy ? L("创建中…", "Creating…") : L("创建任务", "Create task");
  };
  form.onsubmit = async e => {
    e.preventDefault(); if (launchingContext) return;
    clearError();
    if (!title.value.trim()) { showError(new Error(L("请填写任务标题。", "Enter a task title."))); title.focus(); return; }
    const references = picker.payload();
    if (references === null) { showError(new Error(I18N.t("toast.taskFieldsRequired"))); return; }
    setBusy(true);
    let result;
    try {
      await requireAgent(agent);
      const capabilities = await api("/api/tasks/options");
      if (references.length && (!capabilities.context_references || (!automaticRepo && !capabilities.directory_references))) throw new Error(I18N.t("task.referencesUnsupported"));
      if (automaticRepo && !capabilities.context_repository_setup) throw new Error(L("请先更新此设备的本地节点，再自动准备 Context 仓库。", "Update this device's local node before automatic repository setup."));
      const destination = automaticRepo ? { workspace_mode: "context" } : { repo_id: 0, cwd_mode: "managed" };
      if (!automaticRepo) await requireDirectoryTasks(true);
      const body = { context_id: meta.id, revision_id: meta.revision.id, ...destination, agent,
        title: title.value.trim(), prompt: prompt.value, agent_model: model.value, acknowledge: true, references };
      if (capabilities.context_repository_setup) {
        const response = await fetch(nodePath("/api/junction/continue?stream=1"), {
          method: "POST", headers: { "content-type": "application/json", "X-Lang": I18N.lang },
          body: JSON.stringify(body), signal: AbortSignal.timeout(360000),
        });
        result = await readShareStream(response, updateProgress, "任务创建");
      } else result = await send("/continue", body);
    } catch (error) { setBusy(false); showError(error); void hooks.loadRepos(); return; }
    setBusy(false); closeJunction(); settings.showWorkbench?.();
    try {
      await hooks.loadRepos(); await hooks.loadTasks(); hooks.connect(result.id); toast(L("已创建接续任务", "Continuation task created"), "success");
    } catch {
      toast(L(`任务 #${result.id} 已创建，请刷新任务列表后打开。`, `Task #${result.id} was created. Refresh the task list to open it.`), "error");
    }
  };
  target.append(form);
}
function renderShare(job) {
  const feedback = $("jx-share-feedback");
  feedback.hidden = false;
  feedback.dataset.state = job.error ? "error" : job.done ? "success" : "pending";
  $("jx-share-label").textContent = job.error ? L("共享失败", "Sharing failed") : job.done ? L("共享成功", "Shared successfully") : L("共享中…", "Sharing…");
  $("jx-share-progress").value = job.done ? 3 : job.progress;
  $("jx-share-error").textContent = job.error || "";
  $("jx-share-error").hidden = !job.error;
}
async function shareTask(taskId) {
  closeJunction();
  if (activeShare) return;
  clearTimeout(shareDismissTimer);
  const job = { progress: 0, done: false, error: null };
  activeShare = job;
  $("term-share-context").disabled = true;
  renderShare(job);
  try {
    const response = await fetch(nodePath("/api/junction/publish?stream=1"), {
      method: "POST", headers: { "content-type": "application/json", "X-Lang": I18N.lang },
      body: JSON.stringify({ task_id: taskId }), signal: AbortSignal.timeout(180000),
    });
    const result = await readShareStream(response, event => {
      // Overall milestones: snapshot captured, records stored, receipt confirmed.
      // Do not simulate upload percentages or finish before the completion receipt.
      const progress = { snapshot: 1, stored: 2 }[event.stage] || 0;
      job.progress = Math.max(job.progress, progress);
      renderShare(job);
    });
    if (result.status === "failed") throw new Error(L("原始记录已保存，但未解析出可接续的对话。", "The original was saved, but no readable conversation was found."));
    job.done = true;
    renderShare(job);
    if (listReady) loadList().catch(() => {});
  } catch (e) {
    job.error = e.message || L("共享结果未确认，可以重试。", "Sharing was not confirmed. You can retry.");
    renderShare(job);
  } finally {
    activeShare = null; $("term-share-context").disabled = false;
    shareDismissTimer = setTimeout(() => { $("jx-share-feedback").hidden = true; }, job.error ? 10000 : 1500);
  }
}
function showPublish() {
  const tasks = hooks.allTasks().filter(t => t.kind !== "local" && canShareAgent(t.agent));
  if (tasks.some(t => t.id === state.selectedTaskId)) return shareTask(state.selectedTaskId);
  ++generation; selectedContext = null;
  const d = detailRoot(L("选择要共享的任务", "Choose a task to share"));
  for (const task of tasks) d.append(button(task.title, () => shareTask(task.id), "jx-card"));
  if (!tasks.length) d.append(note(L("还没有可共享的 Agent 任务。", "No agent tasks to share yet.")));
}
export function initJunction(callbacks, options = {}) {
  hooks = callbacks;
  settings = options;
  if (settings.cacheKey) try {
    const cached = JSON.parse(sessionStorage.getItem(settings.cacheKey));
    if (cached && Date.now() - cached.at < 15 * 60 * 1000 && Array.isArray(cached.items)
      && cached.items.every(m => typeof m.id === 'string' && typeof m.title === 'string' && m.revision?.id && m.revision.normalized)) {
      listItems = cached.items.map(m => ({ ...m, _cached: true })); listReady = true; listCursor = cached.cursor;
    }
  } catch {}
  const modal = el("div"); modal.id = "junction-modal"; modal.hidden = true;
  modal.innerHTML = `<section class="jx-shell" role="dialog" aria-modal="true" aria-labelledby="jx-heading">
    <div class="jx-head"><h2 id="jx-heading"></h2><span class="jx-spacer"></span><button id="jx-connect" class="sec"></button><button id="jx-refresh" class="sec"></button><button class="sec" id="jx-close" aria-label="Close">×</button></div>
    <div class="jx-search-bar"><label class="jx-search-field"><span class="jx-search-icon" aria-hidden="true"></span><input id="jx-search" type="search" autocomplete="off" spellcheck="false"></label><span id="jx-count" role="status" aria-live="polite" aria-atomic="true"></span></div>
    <p id="jx-error" class="jx-warning" role="alert" hidden></p>
    <div class="jx-body"><div id="jx-library"><div id="jx-list"></div><button id="jx-more" class="sec" hidden></button></div><div id="jx-library-loading" class="jx-loading" role="status" aria-hidden="true"><div class="spinner" aria-hidden="true"></div><span id="jx-loading-label"></span></div></div>
  </section>`;
  (settings.mount || document.body).append(modal);
  if (settings.mount) {
    modal.className = 'context-page';
    const shell = modal.firstElementChild; shell.setAttribute('role', 'region'); shell.removeAttribute('aria-modal');
    shell.removeAttribute('aria-labelledby'); shell.setAttribute('aria-label', 'Context');
    modal.querySelector('.jx-head').hidden = true;
    modal.querySelector('#jx-connect').hidden = !!settings.continueContext || !!settings.managed; modal.querySelector('#jx-close').hidden = true;
    const toolbar = modal.querySelector('.jx-search-bar');
    const scopes = el('div', undefined, 'jx-scopes'); scopes.setAttribute('role', 'group'); scopes.setAttribute('aria-label', L('共享范围', 'Shared contexts'));
    for (const [value, label] of [['all', L('全部共享', 'All contexts')], ['mine', L('我共享的', 'Shared by me')]]) {
      if (value === 'mine' && !settings.userId) continue;
      const scope = el('button', label); scope.type = 'button'; scope.dataset.scope = value; scope.setAttribute('aria-pressed', String(listScope === value));
      scope.onclick = () => {
        listScope = value;
        for (const b of scopes.children) b.setAttribute('aria-pressed', String(b === scope));
        renderContextList();
      };
      scopes.append(scope);
    }
    toolbar.prepend(scopes); toolbar.append(modal.querySelector('#jx-connect'), modal.querySelector('#jx-refresh'));
    const collection = el('section', undefined, 'jx-collection'); collection.setAttribute('aria-label', L('共享记录', 'Shared contexts'));
    const body = modal.querySelector('.jx-body'); body.before(collection); collection.append(body);
  }
  const taskModal = el("div"); taskModal.id = "jx-task-modal"; taskModal.hidden = true;
  taskModal.innerHTML = `<section class="jx-shell jx-task-shell" role="dialog" aria-modal="true" aria-labelledby="jx-task-heading" tabindex="-1">
    <div class="jx-head"><h2 id="jx-task-heading"></h2><span class="jx-spacer"></span><button id="jx-task-close" class="sec" type="button">×</button></div>
    <nav id="jx-task-navigation" class="jx-mode-navigation" aria-label="Context" hidden></nav>
    <p id="jx-task-error" class="jx-warning" role="alert" hidden></p>
    <div id="jx-detail"></div>
    <div class="dlg-actions jx-task-actions"><button id="jx-task-cancel" class="sec" type="button"></button><div id="jx-task-submit-slot"></div></div>
  </section>`;
  document.body.append(taskModal);
  $("jx-task-close").setAttribute("aria-label", L("关闭", "Close"));
  $("jx-task-close").onclick = () => closeContextDialog();
  $("jx-task-cancel").textContent = L("取消", "Cancel");
  $("jx-task-cancel").onclick = () => closeContextDialog();
  const feedback = el("div"); feedback.id = "jx-share-feedback"; feedback.hidden = true;
  feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite"); feedback.setAttribute("aria-atomic", "true");
  feedback.innerHTML = `<span id="jx-share-label"></span><progress id="jx-share-progress" max="3" value="0" aria-labelledby="jx-share-label"></progress><p id="jx-share-error" hidden></p>`;
  document.body.append(feedback);
  $("jx-heading").textContent = settings.mount ? 'Context' : L("共享 Context", "Shared contexts");
  $("jx-search").placeholder = L("搜索标题或用户名", "Search titles or people");
  $("jx-search").setAttribute("aria-label", $("jx-search").placeholder);
  $("jx-search").oninput = () => { renderContextList(); $("jx-library").scrollTop = 0; };
  $("jx-loading-label").textContent = L("加载中…", "Loading…");
  $("jx-close").onclick = closeJunction;
  modal.onclick = e => {
    if (e.target === modal) closeJunction();
  };
  document.addEventListener("keydown", e => {
    if (document.querySelector("dialog[open]")) return;
    if (contextDialogIsOpen()) {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation(); closeContextDialog();
      } else if (e.key === "Tab") {
        const focusable = [...taskModal.querySelectorAll("button, input, select, textarea, summary, a[href], [tabindex]")]
          .filter(node => node.tabIndex >= 0 && !node.matches(":disabled") && !node.closest("[inert]") && node.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1), active = document.activeElement;
        if (!first || !taskModal.contains(active) || (e.shiftKey ? active === first : active === last)) {
          e.preventDefault(); (e.shiftKey ? last : first)?.focus({ preventScroll: true });
        }
      }
      return;
    }
  }, true);
  $("jx-refresh").textContent = L("刷新", "Refresh");
  $("jx-connect").textContent = L("连接", "Connect");
  $("jx-connect").onclick = () => showConnection();
  $("jx-refresh").onclick = () => loadList();
  $("jx-more").textContent = L("加载更多", "Load more"); $("jx-more").onclick = () => loadList(true);
  if (listReady) renderContextList();
  if (settings.continueContext) return;
  ($("junction-nav").querySelector('.primary-nav-label') || $("junction-nav")).textContent = 'Context';
  if (!settings.mount) $("junction-nav").onclick = event => { event.preventDefault(); openJunction(); };
  $("term-share-context").textContent = L("共享", "Share");
  $("term-share-context").title = L("共享当前 Context", "Share this context");
  $("term-share-context").onclick = () => {
    const id = state.selectedTaskId;
    if (Number.isInteger(id)) shareTask(id);
    else { openJunction().then(() => showPublish()); }
  };
}
