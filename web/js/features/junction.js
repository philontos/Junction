import { $, api, nodePath } from "../core/dom.js";
import { state } from "../core/state.js";
import { toast } from "../core/feedback.js";
import { readShareStream } from "./junction-stream.js";

const L = (zh, en) => I18N.lang === "zh" ? zh : en;
let hooks, status, listCursor, messageCursor, generation = 0, listRequest = 0, activeShare = null, shareDismissTimer;
let selectedContext = null, launchingContext = false, connectingJunction = false;
const call = (url, options = {}) => api("/api/junction" + url, options);
const send = (url, body, method = "POST") => call(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const base = meta => `/contexts/${meta.id}/revisions/${meta.revision.id}`;
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function button(text, fn, cls = "sec") { const b = el("button", text, cls); b.type = "button"; b.onclick = async () => { b.disabled = true; try { await fn(); } catch(e) { showError(e); } finally { b.disabled = false; } }; return b; }
const contextDialogIsOpen = () => !$("jx-task-modal").hidden;
function showError(e, id = contextDialogIsOpen() ? "jx-task-error" : "jx-error") { $(id).textContent = e.message || String(e); $(id).hidden = false; }
function clearError(id = contextDialogIsOpen() ? "jx-task-error" : "jx-error") { $(id).hidden = true; }
function select(options, label) { const s = el("select"); s.setAttribute("aria-label", label); for (const [value, text] of options) s.append(new Option(text, value)); return s; }
function field(label, input) { const f = el("label", undefined, "jx-field"); f.append(el("span", label), input); return f; }
function textInput(value = "", placeholder = "") { const input = el("input"); input.value = value; input.placeholder = placeholder; return input; }
function note(text) { return el("p", text, "jx-note"); }
const agentNames = new Map([["claude", "Claude Code"], ["codex", "Codex"], ["kimi", "Kimi"], ["pi", "Pi"]]);
const agentName = provider => agentNames.get(provider) || provider || "Agent";
const contextOwner = meta => meta.owner_id || L("未记录", "Not recorded");
function contextCopy(meta) {
  const overview = meta.revision.normalized?.extensions?.["junction.overview/1"];
  return { title: overview?.title || meta.title, summary: overview?.summary || "" };
}
function cardFact(kind, text) {
  const fact = el("span", undefined, `jx-card-fact jx-card-${kind}`);
  const icon = el("span", undefined, `jx-fact-icon jx-icon-${kind}`); icon.setAttribute("aria-hidden", "true");
  fact.title = kind === "owner" ? `${L("共享者", "Shared by")}: ${text}` : text;
  fact.append(icon, el("span", text)); return fact;
}
function closeContextDialog(restoreFocus = true) {
  if (launchingContext || connectingJunction) return false;
  if (!contextDialogIsOpen()) return true;
  ++generation;
  $("jx-task-modal").hidden = true;
  $("junction-modal").inert = false;
  $("junction-modal").removeAttribute("aria-hidden");
  $("jx-detail").replaceChildren(); $("jx-task-submit-slot").replaceChildren();
  if (restoreFocus) {
    const card = [...$("jx-list").querySelectorAll(".jx-card")].find(b => b.dataset.contextId === selectedContext?.cid);
    (card || $("jx-refresh")).focus({ preventScroll: true });
  }
  return true;
}
function detailRoot(title = L("新建任务", "New task")) {
  const opening = !contextDialogIsOpen();
  $("jx-task-modal").dataset.view = "task";
  $("jx-task-heading").textContent = title;
  $("jx-task-modal").hidden = false;
  if (opening) $("jx-task-close").focus({ preventScroll: true });
  $("junction-modal").inert = true;
  $("junction-modal").setAttribute("aria-hidden", "true");
  clearError("jx-task-error");
  $("jx-task-submit-slot").replaceChildren();
  const d = $("jx-detail"); d.replaceChildren(); return d;
}
export function closeJunction() { if (!closeContextDialog(false)) return; $("junction-modal").hidden = true; generation++; }
export function junctionIsOpen() { return !$("junction-modal").hidden; }
export async function openJunction(taskId = null) {
  if (taskId) return shareTask(taskId);
  if (!closeContextDialog(false)) return;
  const epoch = ++generation;
  $("junction-modal").hidden = false;
  selectedContext = null;
  $("jx-detail").replaceChildren();
  clearError("jx-error");
  try {
    const connection = await call("/connection");
    if (epoch !== generation) return;
    if (!connection.configured) {
      $("jx-list").replaceChildren(button(L("连接 Junction", "Connect Junction"), () => showConnection(), "jx-empty sec"));
      $("jx-more").hidden = true;
      return showConnection(connection);
    }
    await Promise.all([refreshStatus(), loadList()]);
  } catch (e) { if (epoch === generation) showError(e); }
}
async function refreshStatus() {
  status = await call("/status");
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
async function loadList(append = false) {
  const request = ++listRequest, list = $("jx-list");
  const cursor = append ? listCursor : null;
  clearError("jx-error");
  list.setAttribute("aria-busy", "true"); $("jx-more").disabled = true;
  if (!append) {
    listCursor = null; $("jx-more").hidden = true;
    list.replaceChildren(el("p", L("读取中…", "Loading…"), "jx-empty"));
  }
  try {
    const page = await call("/contexts" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""));
    if (request !== listRequest) return;
    if (!append) list.replaceChildren();
    for (const item of page.items) {
      const r = item.revision, workspace = r.normalized?.extensions?.["switchyard.workspace/1"] || r.normalized?.extensions?.["switchyard.capture/1"];
      const copy = contextCopy(item);
      const group = el("div", undefined, "jx-context-card");
      const card = button("", () => openDetail(item), "jx-card");
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
      list.append(group);
    }
    if (!list.children.length) list.append(el("p", L("还没有共享的 Context", "No shared contexts yet"), "jx-empty"));
    listCursor = page.next_cursor; $("jx-more").hidden = !listCursor;
  } catch (e) {
    if (request !== listRequest) return;
    if (!append) list.replaceChildren(button(L("重新加载", "Retry"), () => loadList()));
    if (junctionIsOpen()) showError(e, "jx-error");
  } finally {
    if (request === listRequest) { list.setAttribute("aria-busy", "false"); $("jx-more").disabled = false; }
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
function openDetail(meta) {
  if (launchingContext) return;
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
  showContinue(meta);
  const history = el("details", undefined, "jx-section");
  history.append(el("summary", `${L("查看历史记录", "View history")} · ${r.message_count}`));
  const msgs = el("div"); msgs.id = "jx-messages"; msgs.append(note(L("读取中…", "Loading…"))); history.append(msgs);
  const more = button(L("继续读取", "Load more"), () => loadMessages(meta, true)); more.id = "jx-message-more"; more.hidden = true; history.append(more);
  const contextInfo = el("details", undefined, "jx-section jx-context-info");
  contextInfo.append(el("summary", L("查看 Context 详情", "View context details")), versionList(meta), history); d.append(contextInfo);
  const details = el("details", undefined, "jx-section");
  details.append(el("summary", L("详细信息与导出", "Details and export")), el("code", `${cid} / ${rid}`, "jx-ids"));
  details.append(note(`${new Date(r.created_at).toLocaleString()} · ${r.turn_count} ${L("轮对话", "turns")}`));
  const overview = r.normalized.extensions?.["junction.overview/1"];
  if (overview) details.append(el("p", overview.description, "jx-note jx-description"));
  const capture = r.normalized.extensions?.["switchyard.capture/1"];
  if (capture?.notes) for (const item of capture.notes) details.append(note(item.detail));
  if (w) details.append(note(`${L("代码版本", "Commit")}: ${w.commit}`));
  const environment = r.normalized.extensions?.["junction.environment/1"];
  const environmentDetails = el("details", undefined, "jx-section");
  environmentDetails.append(el("summary", L("来源环境", "Source environment")));
  if (environment) {
    environmentDetails.append(note(L("记录分享时的环境线索；接续 Agent 会按需检查当前设备。", "Captured environment evidence; the receiving agent checks the current device as needed.")));
    const names = { system: L("系统", "System"), workspace: L("工作区", "Workspace"), runtimes: L("运行时", "Runtimes"), dependencies: L("依赖文件", "Dependency files"), agent: "Agent", tools: L("工具", "Tools"), skills: "Skills", variables: L("变量名称", "Variable names"), services: L("服务", "Services"), resources: L("文件资源", "Resources"), access: L("权限需求", "Access") };
    const coverage = { collected: L("已记录", "Recorded"), partial: L("部分记录", "Partial"), not_collected: L("未采集", "Not collected"), not_applicable: L("不适用", "Not applicable") };
    for (const [key, value] of Object.entries(environment.groups || {})) {
      const row = el("details");
      const count = value.items?.length || 0;
      row.append(el("summary", `${names[key] || key} · ${coverage[value.coverage] || value.coverage}${count ? ` · ${count}` : ""}`), el("pre", JSON.stringify(value, null, 2)));
      environmentDetails.append(row);
    }
  } else environmentDetails.append(note(L("此版本未记录环境清单。接续时由 Agent 检查本机环境。", "This version has no environment manifest. The receiving agent checks locally.")));
  contextInfo.append(environmentDetails);
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
        closeJunction(); hooks.connect(w.source.task_id);
      } else {
        await hooks.loadFleet();
        if (!state.fleet[host.id]?.tasks?.some(t => t.id === w.source.task_id)) throw new Error(L("原设备离线或原任务不可用，仍可拉取这份 Context。", "Source device or task unavailable. This context remains readable."));
        closeJunction(); hooks.connectNode(host.id, w.source.task_id);
      }
    }));
  }
  details.append(actions); contextInfo.append(details);
  let loaded = false, loading = false;
  contextInfo.ontoggle = async () => {
    if (!contextInfo.open || loaded || loading) return;
    loading = true;
    try {
      await loadMessages(meta);
      if (epoch !== generation) return;
      if (r.diagnostic_count) {
        const diagnostics = await call(base(meta) + "/diagnostics?limit=100");
        if (epoch !== generation) return;
        const info = el("details"); info.append(el("summary", `${L("解析说明", "Parsing notes")} (${r.diagnostic_count})`), el("pre", JSON.stringify(diagnostics.items, null, 2)));
        details.append(info);
      }
      loaded = true;
    } catch (e) { if (epoch === generation) showError(e); }
    finally { loading = false; }
  };
}
async function loadMessages(meta, more = false) {
  const epoch = generation;
  const q = new URLSearchParams({ limit: "15", view: "trace" }); if (more && messageCursor) q.set("cursor", messageCursor);
  const page = await call(base(meta) + `/messages?${q}`);
  if (epoch !== generation) return;
  const target = $("jx-messages"); if (!more) target.replaceChildren();
  for (const m of page.items) {
    const box = el("details", undefined, "jx-message");
    const content = m.content_truncated ? m.content_preview : m.content?.map(b => b.text || (b.kind === "tool_call" ? `${b.name} (${b.call_id})` : b.kind)).join("\n");
    box.append(el("summary", `${m.role} · ${m.id} · ${String(content || "").slice(0, 160)}`));
    const pre = el("pre", m.content_truncated ? L("展开后加载完整内容…", "Open to load the complete content…") : JSON.stringify(m.content, null, 2)); box.append(pre);
    box.ontoggle = async () => {
      if (!box.open || !m.content_truncated) return;
      box.ontoggle = null;
      try {
        let offset = 0, text = "";
        do { const chunk = await call(base(meta) + `/messages/${m.id}/content?offset=${offset}`); text += chunk.text; offset = chunk.next_offset; } while (offset !== null);
        pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
      } catch(e) { pre.textContent = e.message; }
    };
    target.append(box);
  }
  messageCursor = page.next_cursor; $("jx-message-more").hidden = !messageCursor;
}
function showContinue(meta) {
  const target = $("jx-detail").querySelector(".jx-continuation"); target.replaceChildren();
  if (meta.revision.status === "failed") { target.append(note(L("记录解析失败，暂时无法接续。请查看详细信息。", "This record could not be parsed. Review the details before continuing."))); return; }
  const repos = state.repos.filter(r => r.status === "ready" && state.hostsById[r.host_id]?.kind === "local");
  if (!repos.length) { target.append(note(L("请先在 Switchyard 的本机入口添加一个仓库。", "Add a repository on this machine first."))); return; }
  const w = meta.revision.normalized.extensions?.["switchyard.workspace/1"];
  const hint = w || meta.revision.normalized.extensions?.["switchyard.capture/1"];
  const matches = repos.filter(r => r.name === hint?.repo_name || r.git_url === hint?.repo_url);
  const match = matches.length === 1 ? matches[0] : null;
  const repo = select([["", L("选择本机仓库", "Choose a local repository")], ...repos.map(r => [String(r.id), r.name])], "Repository");
  if (match) repo.value = String(match.id);
  repo.required = true;
  let agent = meta.revision.provider;
  const agents = el("div", undefined, "agent-seg"); agents.setAttribute("role", "group"); agents.setAttribute("aria-label", "Agent");
  for (const [value, label] of [["claude", "Claude Code"], ["codex", "Codex"]]) {
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
  const branch = textInput(match?.default_branch || "main");
  repo.onchange = () => { branch.value = repos.find(r => r.id === Number(repo.value))?.default_branch || "main"; };
  const prompt = el("textarea"); prompt.rows = 2; prompt.maxLength = 8000; prompt.placeholder = L("接下来要做什么？留空则按 Context 继续。", "What should the agent do next? Leave blank to continue from the context.");
  const model = textInput("", L("默认模型", "Default model")); model.maxLength = 100;
  const form = el("form", undefined, "jx-form"); form.id = "jx-task-form";
  const fields = el("fieldset"); form.append(fields);
  const agentField = el("div", undefined, "jx-field"); agentField.append(el("span", "Agent"), agents);
  fields.append(agentField, field(L("本机仓库", "Local repository"), repo), field(L("任务标题", "Task title"), title), field(L("补充要求（可选）", "Instructions (optional)"), prompt));
  const options = el("details", undefined, "jx-section"); options.append(el("summary", L("更多设置", "More options")));
  options.append(field(L("模型", "Model"), model));
  if (!w) {
    branch.required = true;
    fields.append(field(L("起始分支", "Base branch"), branch), note(L("来源代码版本未完整记录，将从本机所选分支继续。", "The source code version was not fully recorded. Continue from the selected local branch.")));
  }
  fields.append(options);
  if (w?.dirty) fields.append(el("p", L("将从已提交代码继续。来源的未提交修改未包含在 Context 中。", "Continue from committed code. Uncommitted source changes are not included."), "jx-warning"));
  if (meta.revision.status !== "ready") fields.append(note(L("部分历史内容或关联无法确认，Agent 会先检查记录与当前代码。", "Some history or relationships could not be confirmed. The agent will check the records and current code first.")));
  const submit = el("button", L("创建任务", "Create task"), "primary"); submit.type = "submit"; submit.id = "jx-task-submit"; submit.setAttribute("form", form.id);
  $("jx-task-submit-slot").append(submit);
  const setBusy = busy => {
    launchingContext = busy; fields.disabled = busy; submit.disabled = busy;
    $("jx-task-close").disabled = busy; $("jx-task-cancel").disabled = busy; $("jx-detail").inert = busy;
    form.setAttribute("aria-busy", String(busy));
    submit.textContent = busy ? L("创建中…", "Creating…") : L("创建任务", "Create task");
  };
  form.onsubmit = async e => {
    e.preventDefault(); if (launchingContext) return;
    clearError();
    if (!title.value.trim()) { showError(new Error(L("请填写任务标题。", "Enter a task title."))); title.focus(); return; }
    setBusy(true);
    let result;
    try {
      result = await send("/continue", { context_id: meta.id, revision_id: meta.revision.id, repo_id: Number(repo.value), agent,
        title: title.value.trim(), base_branch: branch.value, prompt: prompt.value, agent_model: model.value, acknowledge: true });
    } catch (error) { setBusy(false); showError(error); return; }
    setBusy(false); closeJunction();
    try {
      await hooks.loadTasks(); hooks.connect(result.id); toast(L("已创建接续任务", "Continuation task created"), "success");
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
    if (junctionIsOpen()) loadList().catch(() => {});
  } catch (e) {
    job.error = e.message || L("共享结果未确认，可以重试。", "Sharing was not confirmed. You can retry.");
    renderShare(job);
  } finally {
    activeShare = null; $("term-share-context").disabled = false;
    shareDismissTimer = setTimeout(() => { $("jx-share-feedback").hidden = true; }, job.error ? 10000 : 1500);
  }
}
function showPublish() {
  const tasks = hooks.allTasks().filter(t => t.kind !== "local" && ["claude", "codex"].includes(t.agent));
  if (tasks.some(t => t.id === state.selectedTaskId)) return shareTask(state.selectedTaskId);
  ++generation; selectedContext = null;
  const d = detailRoot(L("选择要共享的任务", "Choose a task to share"));
  for (const task of tasks) d.append(button(task.title, () => shareTask(task.id), "jx-card"));
  if (!tasks.length) d.append(note(L("还没有可共享的 Agent 任务。", "No agent tasks to share yet.")));
}
export function initJunction(callbacks) {
  hooks = callbacks;
  const modal = el("div"); modal.id = "junction-modal"; modal.hidden = true;
  modal.innerHTML = `<section class="jx-shell" role="dialog" aria-modal="true" aria-labelledby="jx-heading">
    <div class="jx-head"><h2 id="jx-heading"></h2><span class="jx-spacer"></span><button id="jx-connect" class="sec"></button><button id="jx-refresh" class="sec"></button><button class="sec" id="jx-close" aria-label="Close">×</button></div>
    <p id="jx-error" class="jx-warning" role="alert" hidden></p>
    <div class="jx-body"><main id="jx-library"><div id="jx-list"></div><button id="jx-more" class="sec" hidden></button></main></div>
  </section>`;
  document.body.append(modal);
  const taskModal = el("div"); taskModal.id = "jx-task-modal"; taskModal.hidden = true;
  taskModal.innerHTML = `<section class="jx-shell jx-task-shell" role="dialog" aria-modal="true" aria-labelledby="jx-task-heading" tabindex="-1">
    <div class="jx-head"><h2 id="jx-task-heading"></h2><span class="jx-spacer"></span><button id="jx-task-close" class="sec" type="button">×</button></div>
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
  $("jx-heading").textContent = L("共享 Context", "Shared contexts");
  $("jx-close").onclick = closeJunction;
  modal.onclick = e => {
    if (e.target === modal) closeJunction();
  };
  document.addEventListener("keydown", e => {
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
  $("jx-refresh").onclick = async () => {
    $("jx-refresh").disabled = true;
    const epoch = generation;
    try { await Promise.all([refreshStatus(), loadList()]); } catch (e) { if (epoch === generation) showError(e); }
    finally { $("jx-refresh").disabled = false; }
  };
  $("jx-more").textContent = L("加载更多", "Load more"); $("jx-more").onclick = () => loadList(true);
  $("junction-nav").textContent = L("共享 Context", "Shared contexts");
  $("junction-nav").onclick = () => openJunction();
  $("term-share-context").textContent = L("共享", "Share");
  $("term-share-context").title = L("共享当前 Context", "Share this context");
  $("term-share-context").onclick = () => {
    const id = state.selectedTaskId;
    if (Number.isInteger(id)) shareTask(id);
    else { openJunction().then(() => showPublish()); }
  };
}
