import { api } from "../core/dom.js";

const L = (zh, en) => I18N.lang === "zh" ? zh : en;
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
let dialog, heading, content, footer, generation = 0, pendingDecision;
function dismiss(confirmed = false) {
  const resolve = pendingDecision; pendingDecision = undefined;
  dialog.close(); ++generation; resolve?.(confirmed);
}

function surface(title) {
  pendingDecision?.(false); pendingDecision = undefined;
  if (!dialog) {
    dialog = el("dialog", null, "jx-preparation-modal"); dialog.setAttribute("aria-labelledby", "jx-preparation-title");
    const header = el("header", null, "jx-preparation-head");
    heading = el("h2"); heading.id = "jx-preparation-title";
    const close = el("button", "×", "jx-preparation-close"); close.type = "button"; close.setAttribute("aria-label", L("关闭", "Close")); close.onclick = () => dismiss();
    header.append(heading, close); content = el("div", null, "jx-preparation-content"); footer = el("footer", null, "jx-preparation-footer");
    dialog.append(header, content, footer); document.body.append(dialog);
    // Keep the receipt visible until an explicit close. Backdrop/Escape never dismiss it.
    dialog.addEventListener("cancel", e => e.preventDefault());
  }
  heading.textContent = title; content.replaceChildren(); footer.replaceChildren();
  if (!dialog.open) dialog.showModal();
  return ++generation;
}
function closeButton() {
  const close = el("button", L("关闭", "Close"), "primary"); close.type = "button"; close.onclick = () => dismiss(); footer.append(close);
}
export function showHandoffReport(report) {
  surface(L("任务启动结果", "Task startup report"));
  const result = report.launch === "started" ? L("Agent 已启动", "Agent started") : report.launch === "failed" ? L("Agent 未启动", "Agent did not start") : L("准备中", "Preparing");
  content.append(el("p", `#${report.task_id} · ${report.agent} · ${result}`, "jx-preparation-summary"));
  content.append(el("p", report.mode === "repo" ? L("仓库任务 · 独立分支与 Worktree", "Repository task · isolated branch and worktree") : L("普通 Agent 任务 · 独立工作目录", "Agent task · independent working directory"), "jx-note"));
  if (report.cwd) content.append(el("code", report.cwd, "jx-preparation-path"));
  const labels = { ready: L("已就绪", "Ready"), missing: L("缺失", "Missing"), unknown: L("待核对", "Unchecked"), different: L("有差异", "Different"), not_applicable: L("不适用", "Not applicable") };
  for (const item of report.items || []) {
    const row = el("section", null, "jx-preparation-item"), top = el("div", null, "jx-preparation-item-head");
    const badge = el("span", labels[item.status] || labels.unknown, "jx-preparation-status"); badge.dataset.status = item.status;
    top.append(el("strong", item.title), badge); row.append(top, el("p", item.message));
    if (item.branch || item.commit) row.append(el("code", [item.branch, item.commit?.slice(0, 12)].filter(Boolean).join(" · ")));
    if (item.path) row.append(el("code", item.path, "jx-preparation-path"));
    content.append(row);
  }
  content.append(el("p", L("这是任务启动时的记录，之后的环境变化需在当前任务核对。", "This records startup observations; verify subsequent changes in the current task."), "jx-note"));
  closeButton();
}
export async function showTaskHandoff(taskId, nodeId = null) {
  const epoch = surface(L("任务启动结果", "Task startup report"));
  const loading = el("div", null, "jx-preparation-loading"); loading.append(el("span", null, "spinner"), el("span", L("读取记录…", "Loading report…"))); content.append(loading); closeButton();
  try {
    const report = await api(nodeId ? `/api/nodes/${Number(nodeId)}/tasks/${Number(taskId)}/handoff` : `/api/junction/tasks/${Number(taskId)}/report`);
    if (epoch === generation && dialog.open) showHandoffReport(report);
  } catch (error) { if (epoch === generation && dialog.open) content.replaceChildren(el("p", error.message, "jx-note")); }
}
export function handoffReportButton(task, nodeId = null) {
  if (!task.handoff) return "";
  const label = L("查看启动与环境记录", "View startup and environment report");
  return `<button class="task-handoff-report" title="${label}" aria-label="${label}" onclick="event.stopPropagation();showTaskHandoff(${Number(task.id)},${nodeId == null ? "null" : Number(nodeId)})"><svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M6 3h8v2H6zM5 4H3v14h14V4h-2M6 9h8M6 12h8M6 15h5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
}
export function confirmShareCheck(check) {
  surface(L("共享前检查", "Before sharing"));
  content.append(el("p", [check.branch, check.commit?.slice(0, 12)].filter(Boolean).join(" · "), "jx-preparation-summary"));
  for (const note of check.notes || []) content.append(el("p", note, "jx-note"));
  if (check.changed_files?.length) {
    const files = el("details"), label = el("summary", L(`查看 ${check.changed_count} 个变更文件`, `View ${check.changed_count} changed files`));
    files.append(label, el("pre", check.changed_files.join("\n"))); content.append(files);
  }
  return new Promise(resolve => {
    pendingDecision = resolve;
    const back = el("button", L("返回任务处理", "Return to task"), "sec"); back.type = "button"; back.onclick = () => dismiss();
    const proceed = el("button", L("仍然共享 Context", "Share context anyway"), "primary"); proceed.type = "button";
    proceed.onclick = () => dismiss(true);
    footer.append(back, proceed);
  });
}
