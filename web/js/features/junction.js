import { $, api } from "../core/dom.js";
import { state } from "../core/state.js";
import { toast } from "../core/feedback.js";
import { readShareStream } from "./junction-stream.js";

const L = (zh, en) => I18N.lang === "zh" ? zh : en;
let hooks, status, listCursor, messageCursor, generation = 0, activeShare = null, shareDismissTimer;
const call = (url, options = {}) => api("/api/junction" + url, options);
const send = (url, body, method = "POST") => call(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const base = meta => `/contexts/${meta.id}/revisions/${meta.revision.id}`;
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function button(text, fn, cls = "sec") { const b = el("button", text, cls); b.type = "button"; b.onclick = async () => { b.disabled = true; try { await fn(); } catch(e) { showError(e); } finally { b.disabled = false; } }; return b; }
function showError(e) { $("jx-error").textContent = e.message || String(e); $("jx-error").hidden = false; }
function clearError() { $("jx-error").hidden = true; }
function select(options, label) { const s = el("select"); s.setAttribute("aria-label", label); for (const [value, text] of options) s.append(new Option(text, value)); return s; }
function field(label, input) { const f = el("label", undefined, "jx-field"); f.append(el("span", label), input); return f; }
function textInput(value = "", placeholder = "") { const input = el("input"); input.value = value; input.placeholder = placeholder; return input; }
function note(text) { return el("p", text, "jx-note"); }
function detailRoot() { clearError(); const d = $("jx-detail"); d.replaceChildren(); return d; }
export function closeJunction() { $("junction-modal").hidden = true; generation++; }
export function junctionIsOpen() { return !$("junction-modal").hidden; }
export async function openJunction(taskId = null) {
  if (taskId) return shareTask(taskId);
  $("junction-modal").hidden = false;
  clearError();
  $("jx-connection").textContent = L("连接 Junction…", "Connecting to Junction…");
  try {
    await refreshStatus();
    await loadList();
  } catch (e) { showError(e); $("jx-connection").textContent = L("Junction 不可用", "Junction unavailable"); }
}
async function refreshStatus() {
  status = await call("/status");
  $("jx-connection").textContent = L("分享前情，在自己的设备上继续工作。", "Share context and continue on your own device.");
}
async function loadList(append = false) {
  const epoch = generation;
  const page = await call("/contexts" + (append && listCursor ? `?cursor=${encodeURIComponent(listCursor)}` : ""));
  if (epoch !== generation) return;
  const list = $("jx-list"); if (!append) list.replaceChildren();
  for (const item of page.items) {
    const r = item.revision;
    const card = button("", () => openDetail(item.id, r.id), "jx-card");
    card.dataset.contextId = item.id;
    card.append(el("strong", item.title), el("span", `${r.provider === "claude" ? "Claude Code" : "Codex"} · ${r.turn_count} ${L("轮对话", "turns")}`, "jx-meta"),
      el("span", new Date(r.created_at).toLocaleString(), "jx-meta"));
    list.append(card);
  }
  if (!list.children.length) list.append(note(L("还没有共享的 Context。分享一个任务，从这里开始接续。", "No shared contexts yet. Share a task to get started.")));
  listCursor = page.next_cursor;
  $("jx-more").hidden = !listCursor;
}
async function openDetail(cid, rid) {
  const epoch = ++generation;
  const meta = await call(`/contexts/${cid}/revisions/${rid}`);
  if (epoch !== generation) return;
  const r = meta.revision, w = r.normalized.extensions?.["switchyard.workspace/1"];
  const d = detailRoot();
  for (const card of $("jx-list").querySelectorAll(".jx-card")) card.classList.toggle("active", card.dataset.contextId === cid);
  d.append(el("h2", meta.title), note(`${r.provider === "claude" ? "Claude Code" : "Codex"} · ${r.turn_count} ${L("轮对话", "turns")}${w ? ` · ${w.repo_name} / ${w.branch}` : ""}`));
  d.append(el("div", undefined, "jx-continuation"));
  showContinue(meta);
  const history = el("details", undefined, "jx-section");
  history.append(el("summary", `${L("查看历史记录", "View history")} · ${r.message_count}`));
  const msgs = el("div"); msgs.id = "jx-messages"; history.append(msgs);
  const more = button(L("继续读取", "Load more"), () => loadMessages(meta, true)); more.id = "jx-message-more"; history.append(more);
  d.append(history);
  const details = el("details", undefined, "jx-section");
  details.append(el("summary", L("详细信息与导出", "Details and export")), el("code", `${cid} / ${rid}`, "jx-ids"));
  const overview = r.normalized.extensions?.["junction.overview/1"];
  if (overview) details.append(el("p", overview.description, "jx-note jx-description"));
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
    const local = w.source.node_id === status.node_id;
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
  details.append(actions); d.append(details);
  if (r.diagnostic_count) {
    const diagnostics = await call(base(meta) + "/diagnostics?limit=100");
    if (epoch !== generation) return;
    const info = el("details"); info.append(el("summary", `${L("解析说明", "Parsing notes")} (${r.diagnostic_count})`), el("pre", JSON.stringify(diagnostics.items, null, 2)));
    details.append(info);
  }
  await loadMessages(meta);
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
  const agent = select([["claude", "Claude Code"], ["codex", "Codex"]], "Agent"); agent.value = meta.revision.provider;
  const title = textInput(`${L("接续", "Continue")}: ${meta.title}`); title.maxLength = 200;
  const branch = textInput(match?.default_branch || "main");
  repo.onchange = () => { branch.value = repos.find(r => r.id === Number(repo.value))?.default_branch || "main"; };
  const prompt = el("textarea"); prompt.rows = 3; prompt.maxLength = 8000; prompt.placeholder = L("补充本次要做的事（可选）", "Additional instructions (optional)");
  const model = textInput("", L("默认模型", "Default model")); model.maxLength = 100;
  const form = el("div", undefined, "jx-form");
  if (!match) form.append(field(L("本机仓库", "Local repository"), repo));
  form.append(field(L("使用哪个 Agent 继续", "Continue with"), agent));
  const options = el("details", undefined, "jx-section"); options.append(el("summary", L("更多设置", "More options")));
  if (match) options.append(field(L("本机仓库", "Local repository"), repo));
  options.append(field(L("任务标题", "Task title"), title), field(L("模型", "Model"), model), field(L("补充要求", "Instructions"), prompt));
  if (!w) form.append(field(L("起始分支", "Base branch"), branch), note(L("来源代码版本未完整记录，将从本机所选分支继续。", "The source code version was not fully recorded. Continue from the selected local branch.")));
  form.append(options);
  if (w?.dirty) form.append(el("p", L("将从已提交代码继续。来源的未提交修改未包含在 Context 中。", "Continue from committed code. Uncommitted source changes are not included."), "jx-warning"));
  if (meta.revision.status !== "ready") form.append(note(L("部分历史内容或关联无法确认，Agent 会先检查记录与当前代码。", "Some history or relationships could not be confirmed. The agent will check the records and current code first.")));
  form.append(button(L("继续工作", "Continue working"), async () => {
    if (!repo.value) throw new Error(L("请选择本机仓库。", "Choose a local repository."));
    const result = await send("/continue", { context_id: meta.id, revision_id: meta.revision.id, repo_id: Number(repo.value), agent: agent.value,
      title: title.value, base_branch: branch.value, prompt: prompt.value, agent_model: model.value, acknowledge: true });
    await hooks.loadTasks(); closeJunction(); hooks.connect(result.id); toast(L("已创建接续任务", "Continuation task created"), "success");
  }, ""));
  form.append(note(L("会在本机新建任务，读取这份前情后继续。", "A new task will read this context and continue on this machine.")));
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
    const response = await fetch("/api/junction/publish?stream=1", {
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
  ++generation; const d = detailRoot();
  d.append(el("h2", L("选择要共享的任务", "Choose a task to share")));
  for (const task of tasks) d.append(button(task.title, () => shareTask(task.id), "jx-card"));
  if (!tasks.length) d.append(note(L("还没有可共享的 Agent 任务。", "No agent tasks to share yet.")));
}
function showImport() {
  ++generation; const d = detailRoot();
  const file = el("input"); file.type = "file"; file.accept = ".jsonl,.ndjson";
  const provider = select([["claude", "Claude Code"], ["codex", "Codex"]], "Provider");
  d.append(el("h2", L("导入已有 JSONL", "Import existing JSONL")), note(L("上传后进入共享列表，接入同一 Junction 的用户可读取并接续。原文件保持不变。", "Uploads appear in the shared list for Junction users to read and continue. The original stays unchanged.")), field("Agent", provider), field("JSONL", file));
  d.append(button(L("导入并分享", "Import and share"), async () => {
    const f = file.files[0]; if (!f) throw new Error(L("请选择 JSONL 文件。", "Choose a JSONL file."));
    if (f.size > 32 * 1024 * 1024) throw new Error("JSONL > 32 MiB");
    const q = new URLSearchParams({ provider: provider.value, name: f.name });
    const result = await call(`/import?${q}`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: f });
    await loadList(); await openDetail(result.context_id, result.id);
  }, ""));
}
export function initJunction(callbacks) {
  hooks = callbacks;
  const modal = el("div"); modal.id = "junction-modal"; modal.hidden = true;
  modal.innerHTML = `<section class="jx-shell" role="dialog" aria-modal="true" aria-labelledby="jx-heading">
    <div class="jx-head"><div><div class="jx-eyebrow">JUNCTION</div><h2 id="jx-heading"></h2></div><span class="jx-spacer"></span><button class="sec" id="jx-close" aria-label="Close">×</button></div>
    <div id="jx-connection" class="jx-status"></div><p id="jx-error" class="jx-warning" role="alert" hidden></p>
    <div class="jx-body"><aside class="jx-sidebar"><div id="jx-tools" class="jx-actions"></div><div id="jx-list"></div><button id="jx-more" class="sec" hidden></button><details class="jx-section"><summary id="jx-extra-label"></summary><div id="jx-extra"></div></details></aside><main id="jx-detail"></main></div>
  </section>`;
  document.body.append(modal);
  const feedback = el("div"); feedback.id = "jx-share-feedback"; feedback.hidden = true;
  feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite"); feedback.setAttribute("aria-atomic", "true");
  feedback.innerHTML = `<span id="jx-share-label"></span><progress id="jx-share-progress" max="3" value="0" aria-labelledby="jx-share-label"></progress><p id="jx-share-error" hidden></p>`;
  document.body.append(feedback);
  $("jx-heading").textContent = L("共享 Context", "Shared contexts");
  $("jx-close").onclick = closeJunction;
  modal.onclick = e => { if (e.target === modal) closeJunction(); };
  $("jx-tools").append(button(L("分享任务", "Share a task"), () => showPublish(), ""), button(L("刷新", "Refresh"), () => loadList()));
  $("jx-extra-label").textContent = L("更多", "More");
  $("jx-extra").append(button(L("导入 JSONL", "Import JSONL"), showImport));
  $("jx-more").textContent = L("加载更多", "Load more"); $("jx-more").onclick = () => loadList(true).catch(showError);
  detailRoot().append(note(L("选择一份共享 Context，继续之前的工作。", "Choose a shared context to continue working.")));
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
