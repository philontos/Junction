import { $, api } from "../core/dom.js";
import { state } from "../core/state.js";
import { toast } from "../core/feedback.js";

const L = (zh, en) => I18N.lang === "zh" ? zh : en;
let hooks, account = localStorage.getItem("junction.account") || "", status, selected, listCursor, messageCursor, generation = 0;
const call = (url, options = {}) => api("/api/junction" + url, { ...options, headers: { ...options.headers, "X-Junction-Account": account } });
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
  $("junction-modal").hidden = false;
  clearError();
  $("jx-connection").textContent = L("连接 Junction…", "Connecting to Junction…");
  try {
    await refreshStatus();
    await loadList();
    if (taskId) await previewTask(taskId);
  } catch (e) { showError(e); $("jx-connection").textContent = L("Junction 不可用", "Junction unavailable"); }
}
async function refreshStatus() {
  try { status = await call("/status"); }
  catch(e) { if (account && e.status === 400) { account = ""; status = await call("/status"); } else throw e; }
  account = status.account;
  const picker = $("jx-account"); picker.replaceChildren(...status.accounts.map(a => new Option(a.label, a.id))); picker.value = account;
  $("jx-connection").textContent = `${status.url} · ${status.user_id} · ${L("本机联调账号", "Local test account")}`;
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
    card.append(el("strong", item.title), el("span", `${r.provider} · v${r.number} · ${item.owner_id}`, "jx-meta"),
      el("span", `${r.message_count} ${L("条记录", "messages")} · ${new Date(r.created_at).toLocaleString()} · ${r.status}`, "jx-meta"));
    list.append(card);
  }
  if (!list.children.length) list.append(note(L("暂无可见的 Context。发布任务或导入 JSONL 后，会显示在这里。", "No visible contexts. Publish a task or import JSONL to get started.")));
  listCursor = page.next_cursor;
  $("jx-more").hidden = !listCursor;
}
async function openDetail(cid, rid) {
  const epoch = ++generation;
  const meta = await call(`/contexts/${cid}/revisions/${rid}`);
  if (epoch !== generation) return;
  selected = meta;
  const r = meta.revision, w = r.normalized.extensions?.["switchyard.workspace/1"];
  const d = detailRoot();
  d.append(el("div", `CONTEXT / v${r.number}`, "jx-eyebrow"), el("h2", meta.title),
    note(`${r.provider} · ${r.status} · ${r.turn_count} ${L("轮", "turns")} / ${r.message_count} ${L("条记录", "messages")}`));
  const ids = el("code", `${cid}\n${rid}`, "jx-ids"); d.append(ids);
  if (r.status !== "ready") d.append(el("p", L("这份记录有解析诊断，部分内容或关联无法确认。请检查下方诊断；原始 JSONL 仍保存在 Junction。", "This record has parsing diagnostics: some content or relationships could not be confirmed. Review the diagnostics below. Junction retains the original JSONL."), "jx-warning"));
  if (w) {
    d.append(note(`${w.repo_name} · ${w.branch} · ${w.commit.slice(0, 12)}`));
    if (w.dirty) d.append(el("p", L("来源有未提交修改：Context 保存了对话，未保存这些代码改动。可回原任务继续，或先同步代码。", "The source has uncommitted changes. These changes are not included in the context; return to the source or synchronize code first."), "jx-warning"));
  } else d.append(note(L("此记录没有工作区信息，接续时需自行选择仓库和分支。", "No workspace metadata. Choose the repository and branch when continuing.")));
  d.append(note(L("历史路径、附件、工具和权限不会自动迁移。当前版本是记录快照，不是原 Agent 运行状态。", "Paths, attachments, tools and permissions are not migrated. This is recorded history, not a running agent state.")));
  const actions = el("div", undefined, "jx-actions");
  const continueButton = button(L("在本机接续", "Continue locally"), () => showContinue(meta), "");
  continueButton.disabled = r.status === "failed";
  actions.append(continueButton, button(L("下载标准 Context", "Export context"), async () => {
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
      } else { await hooks.loadFleet(); if (!state.fleet[host.id]?.tasks?.some(t => t.id === w.source.task_id)) throw new Error(L("原设备离线或原任务不可用，仍可拉取这份 Context。", "Source device or task unavailable. This context remains readable.")); closeJunction(); hooks.connectNode(host.id, w.source.task_id); }
    }));
  }
  d.append(actions, el("div", undefined, "jx-continuation"));
  if (meta.access.owner) await renderGrants(meta, d, epoch);
  if (epoch !== generation) return;
  const diagnostics = await call(base(meta) + "/diagnostics?limit=100");
  if (epoch !== generation) return;
  if (diagnostics.items.length) {
    const details = el("details"); details.append(el("summary", `${L("解析诊断", "Diagnostics")} (${r.diagnostic_count})`), el("pre", JSON.stringify(diagnostics.items, null, 2)));
    d.append(details);
  }
  d.append(el("h3", L("历史记录", "History")));
  const msgs = el("div"); msgs.id = "jx-messages"; d.append(msgs);
  const more = button(L("继续读取", "Load more"), () => loadMessages(meta, true)); more.id = "jx-message-more"; d.append(more);
  await loadMessages(meta);
}
async function renderGrants(meta, parent, epoch) {
  const data = await call(base(meta) + "/grants");
  if (epoch !== generation) return;
  const section = el("details", undefined, "jx-grants"); section.open = true;
  section.append(el("summary", L("共享权限 · 仅此版本", "Sharing · this revision only")));
  const rows = el("div");
  for (const g of data.items || data.grants || data || []) {
    const row = el("div", undefined, "jx-actions");
    row.append(el("span", `${g.user_id}${g.include_raw ? " + JSONL" : ""}`), button(L("撤销", "Revoke"), async () => { await send(base(meta) + `/grants/${encodeURIComponent(g.user_id)}`, {}, "DELETE"); await openDetail(meta.id, meta.revision.id); })); rows.append(row);
  }
  section.append(rows);
  const user = textInput("", L("接收方用户 ID，例如 reviewer", "Recipient user ID, e.g. reviewer")); user.setAttribute("aria-label", L("接收方用户 ID", "Recipient user ID"));
  const raw = el("input"); raw.type = "checkbox";
  const rawLabel = el("label", undefined, "jx-check"); rawLabel.append(raw, el("span", L("同时允许读取原始 JSONL", "Also allow raw JSONL access")));
  const share = button(L("授权共享", "Share"), async () => {
    if (!user.value.trim()) throw new Error(L("请填写接收方用户 ID。", "Enter a recipient user ID."));
    await send(base(meta) + `/grants/${encodeURIComponent(user.value.trim())}`, { include_raw: raw.checked }, "PUT");
    await openDetail(meta.id, meta.revision.id); toast(L("此版本已共享", "Revision shared"), "success");
  }); section.append(user, rawLabel, share); parent.append(section);
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
  clearError();
  const target = $("jx-detail").querySelector(".jx-continuation"); target.replaceChildren();
  const repos = state.repos.filter(r => r.status === "ready" && state.hostsById[r.host_id]?.kind === "local");
  if (!repos.length) { target.append(note(L("请先在 Switchyard 的本机入口添加一个仓库。", "Add a repository on this machine first."))); return; }
  const w = meta.revision.normalized.extensions?.["switchyard.workspace/1"];
  const repo = select(repos.map(r => [String(r.id), r.name]), "Repository");
  const match = repos.find(r => r.name === w?.repo_name); if (match) repo.value = String(match.id);
  const agent = select([["claude", "Claude Code"], ["codex", "Codex"]], "Agent"); agent.value = meta.revision.provider;
  const title = textInput(`${L("接续", "Continue")}: ${meta.title}`); title.maxLength = 200;
  const branch = textInput(repos.find(r => r.id === Number(repo.value))?.default_branch || "main");
  const prompt = el("textarea"); prompt.rows = 3; prompt.maxLength = 8000; prompt.placeholder = L("补充本次要做的事（可选）", "Additional instructions (optional)");
  const model = textInput("", L("默认模型", "Default model")); model.maxLength = 100;
  const form = el("div", undefined, "jx-form");
  form.append(el("h3", L("创建独立 worktree 与新会话", "Create an independent worktree and session")), field(L("本机仓库", "Local repository"), repo), field("Agent", agent), field(L("任务标题", "Task title"), title));
  if (!w) form.append(field(L("起始分支", "Base branch"), branch));
  else form.append(note(`${L("固定代码提交", "Pinned commit")}: ${w.commit}`));
  form.append(field(L("模型（可选）", "Model (optional)"), model), field(L("本次要求", "Instructions"), prompt));
  const acknowledge = el("input"); acknowledge.type = "checkbox";
  const needsAck = w?.dirty || !w || meta.revision.status !== "ready";
  if (needsAck) {
    const label = el("label", undefined, "jx-check"); label.append(acknowledge, el("span", L("我已了解：未提交代码和外部环境不会自动恢复，将检查当前仓库后继续。", "I understand that uncommitted code and external environment are not restored automatically."))); form.append(label);
  }
  form.append(button(L("拉取 Context 并启动 Agent", "Pull context and start agent"), async () => {
    if (needsAck && !acknowledge.checked) throw new Error(L("请先确认工作环境差异。", "Please acknowledge the environment differences."));
    const result = await send("/continue", { context_id: meta.id, revision_id: meta.revision.id, repo_id: Number(repo.value), agent: agent.value,
      title: title.value, base_branch: branch.value, prompt: prompt.value, agent_model: model.value, acknowledge: acknowledge.checked });
    await hooks.loadTasks(); closeJunction(); hooks.connect(result.id); toast(L("已创建接续任务", "Continuation task created"), "success");
  }, "")); target.append(form); target.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function showPublish() {
  ++generation; selected = null;
  const d = detailRoot();
  d.append(el("h2", L("发布任务 Context", "Publish task context")), note(L("选择本机任务，预览后把当前 JSONL 快照存入 Junction。之后可授权给指定用户。", "Choose a local task to archive its JSONL snapshot, then share it with specific users.")));
  const tasks = hooks.allTasks().filter(t => t.kind !== "local" && ["claude", "codex"].includes(t.agent));
  if (!tasks.length) { d.append(note(L("本机尚无 Agent 任务。你也可以导入已有 JSONL。", "No agent tasks yet. You can import an existing JSONL instead."))); return; }
  const picker = select(tasks.map(t => [String(t.id), `#${t.id} ${t.title} · ${t.agent}`]), "Task");
  d.append(field(L("任务", "Task"), picker), button(L("预览发布内容", "Preview snapshot"), () => previewTask(Number(picker.value))));
}
async function previewTask(taskId) {
  const epoch = ++generation;
  const preview = await call(`/tasks/${taskId}/preview`);
  if (epoch !== generation) return;
  const d = detailRoot();
  d.append(el("h2", preview.title), note(`${preview.provider} · ${(preview.bytes / 1024).toFixed(1)} KiB · ${preview.source_name}`),
    note(`${preview.workspace.repo_name} · ${preview.workspace.branch} · ${preview.workspace.commit.slice(0, 12)}`),
    note(L("将归档该会话的原始 JSONL 和标准化历史，可能包括提示词、工具输入与输出。发布后默认仅你可见，再单独授权接收方。", "Archives the original JSONL and normalized history, including recorded prompts and tool inputs/outputs. It stays private until you grant access.")));
  if (preview.workspace.dirty) d.append(el("p", L("存在未提交代码改动。这些代码不会随 Context 上传。", "Uncommitted code changes will not be uploaded with this context."), "jx-warning"));
  d.append(button(L("存入 Junction", "Save to Junction"), async () => {
    const result = await send("/publish", { task_id: taskId });
    await loadList(); await openDetail(result.context_id, result.id);
    toast(L("已保存，可在下方授权共享", "Saved. You can now grant access below."), "success");
  }, ""));
}
function showImport() {
  ++generation; selected = null; const d = detailRoot();
  const file = el("input"); file.type = "file"; file.accept = ".jsonl,.ndjson";
  const provider = select([["claude", "Claude Code"], ["codex", "Codex"]], "Provider");
  const title = textInput("", L("Context 标题", "Context title")); title.maxLength = 200;
  d.append(el("h2", L("导入已有 JSONL", "Import existing JSONL")), note(L("原文件只读。完整文件上传至 Junction，重复导入会复用已有快照。", "The original stays unchanged. Junction stores the complete file and deduplicates repeated imports.")), field("Agent", provider), field(L("标题", "Title"), title), field("JSONL", file));
  d.append(button(L("上传并归档", "Upload and archive"), async () => {
    const f = file.files[0]; if (!f) throw new Error(L("请选择 JSONL 文件。", "Choose a JSONL file."));
    if (f.size > 32 * 1024 * 1024) throw new Error("JSONL > 32 MiB");
    const q = new URLSearchParams({ provider: provider.value, name: f.name, title: title.value || f.name });
    const result = await call(`/import?${q}`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: f });
    await loadList(); await openDetail(result.context_id, result.id);
  }, ""));
}
export function initJunction(callbacks) {
  hooks = callbacks;
  const modal = el("div"); modal.id = "junction-modal"; modal.hidden = true;
  modal.innerHTML = `<section class="jx-shell" role="dialog" aria-modal="true" aria-labelledby="jx-heading"><div class="jx-head"><div><div class="jx-eyebrow">SWITCHYARD × JUNCTION</div><h2 id="jx-heading">Contexts</h2></div><span class="jx-spacer"></span><select id="jx-account" aria-label="Junction account"></select><button class="sec" id="jx-close" aria-label="Close">×</button></div><div id="jx-connection" class="jx-status"></div><p id="jx-error" class="jx-warning" role="alert" hidden></p><div class="jx-body"><aside class="jx-sidebar"><div id="jx-tools" class="jx-actions"></div><div id="jx-list"></div><button id="jx-more" class="sec" hidden></button></aside><main id="jx-detail"></main></div></section>`;
  document.body.append(modal);
  $("jx-close").onclick = closeJunction;
  modal.onclick = e => { if (e.target === modal) closeJunction(); };
  $("jx-account").onchange = async e => {
    generation++; account = e.target.value; localStorage.setItem("junction.account", account); selected = null;
    detailRoot().append(note(L("选择一份 Context 查看或接续。此账号选择器用于本机联调，不是独立用户登录。", "Select a context. This account selector is for local testing, not separate user login.")));
    try { await refreshStatus(); await loadList(); } catch(e) { showError(e); }
  };
  $("jx-tools").append(button(L("发布任务", "Publish task"), showPublish), button(L("导入 JSONL", "Import JSONL"), showImport), button("↻", () => loadList()));
  $("jx-more").textContent = L("加载更多", "Load more"); $("jx-more").onclick = () => loadList(true).catch(showError);
  detailRoot().append(note(L("Context 在这里保存和共享，工作继续在各自设备上进行。选择记录查看详情，或发布一个任务。", "Store and share contexts here; continue work on your own devices. Select a context or publish a task.")));
  $("junction-nav").onclick = () => openJunction();
  $("term-share-context").onclick = () => {
    const id = state.selectedTaskId;
    if (Number.isInteger(id)) openJunction(id);
    else { openJunction().then(() => showPublish()); }
  };
}
