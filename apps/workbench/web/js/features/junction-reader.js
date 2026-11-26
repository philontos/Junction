// Human-readable projection of the portable Context. Historical text is always
// inert DOM text; unknown provider blocks stay available in their record details.
const L = (zh, en) => I18N.lang === "zh" ? zh : en;
function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function action(label, fn, cls = "sec") { const b = el("button", label, cls); b.type = "button"; b.onclick = fn; return b; }
function fold(label, cls = "jx-record-fold") { const box = el("details", null, cls); box.append(el("summary", label)); return box; }
const valueText = value => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "—";
const dateText = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const roleNames = () => ({ user: L("用户", "User"), assistant: "Agent", tool: L("工具", "Tool"), system: L("系统", "System"), developer: L("运行指令", "Instructions"), unknown: L("其他记录", "Other record") });
const groupNames = () => ({ system: L("系统", "System"), workspace: L("工作区", "Workspace"), repositories: L("参考仓库", "Reference repositories"), runtimes: L("运行时", "Runtimes"), dependencies: L("依赖文件", "Dependencies"), agent: "Agent", tools: L("工具", "Tools"), skills: "Skills", variables: L("环境变量名称", "Variable names"), services: L("外部服务", "Services"), resources: L("文件资源", "Resources"), access: L("权限需求", "Access") });
const coverageNames = () => ({ collected: L("已记录", "Recorded"), partial: L("部分记录", "Partial"), not_collected: L("未采集", "Not collected"), not_applicable: L("不适用", "Not applicable") });
const statusNames = () => ({ present: L("已检测到", "Detected"), missing: L("未检测到", "Not detected"), unknown: L("未验证", "Unverified") });
const fieldNames = () => ({ name: L("名称", "Name"), version: L("版本", "Version"), platform: L("平台", "Platform"), arch: L("架构", "Architecture"), release: L("系统版本", "OS version"), shell: "Shell", configured_shell: "Shell", repo_name: L("仓库", "Repository"), repo_url: L("仓库地址", "Repository URL"), commit: L("固定提交", "Pinned commit"), requested_ref: L("来源分支", "Source branch"), mode: L("用途", "Mode"), branch: L("分支", "Branch"), commit: L("提交", "Commit"), dirty: L("有未提交修改", "Uncommitted changes"), bytes: L("字节数", "Bytes"), engines: L("运行时要求", "Runtime requirements"), cwd: L("工作目录", "Working directory"), reference: L("路径 / 引用", "Path / reference"), path: L("路径", "Path"), kind: L("类型", "Type"), invoked: L("任务中使用过", "Used in task"), included: L("随 Context 保存", "Included"), alias: L("别名", "Alias"), capability: L("所需能力", "Capability"), resource_ref: L("资源引用", "Resource"), command: L("命令", "Command"), cmd: L("命令", "Command"), scripts: L("项目脚本", "Project scripts"), package_manager: L("包管理器", "Package manager"), sha256: L("内容校验", "Checksum") });

function inline(parent, text) {
  // Deliberately small Markdown subset, built without innerHTML. No HTML, images,
  // relative file links or executable URL schemes are interpreted from history.
  const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    const token = match[0];
    if (token.startsWith("`")) parent.append(el("code", token.slice(1, -1)));
    else if (token.startsWith("**")) parent.append(el("strong", token.slice(2, -2)));
    else {
      const split = token.indexOf("](");
      const a = el("a", token.slice(1, split)); a.href = token.slice(split + 2, -1); a.target = "_blank"; a.rel = "noopener noreferrer"; parent.append(a);
    }
    offset = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
function markdown(text) {
  const body = el("div", null, "jx-prose"), lines = String(text || "").replaceAll("\r\n", "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const code = [], marker = fence[1]; i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) code.push(lines[i++]);
      if (i < lines.length) i++;
      const block = el("div", null, "jx-code-block");
      if (fence[2].trim()) block.append(el("span", fence[2].trim(), "jx-code-label"));
      const pre = el("pre"); pre.append(el("code", code.join("\n"))); block.append(pre); body.append(block); continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { const h = el("h4"); inline(h, heading[1]); body.append(h); i++; continue; }
    const list = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (list) {
      const ordered = /^\s*\d/.test(line), ul = el(ordered ? "ol" : "ul");
      if (ordered) ul.start = Number(line.match(/\d+/)[0]);
      while (i < lines.length) {
        const item = lines[i].match(ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        const li = el("li"); inline(li, item[1]); ul.append(li); i++;
      }
      body.append(ul); continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      const block = el("blockquote"); inline(block, quote.join("\n")); body.append(block); continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { body.append(el("hr")); i++; continue; }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(?:#{1,6}\s|`{3}|~{3}|>|[-*+]\s|\d+[.)]\s)/.test(lines[i])) paragraph.push(lines[i++]);
    const p = el("p"); inline(p, paragraph.join("\n")); body.append(p);
  }
  return body;
}
function readableText(text) {
  const value = String(text || "");
  if (value.length <= 5000) return markdown(value);
  const box = el("div"); box.append(markdown(value.slice(0, 4000) + "…"));
  box.append(action(L("展开全文", "Read full message"), () => box.replaceChildren(markdown(value)), "jx-text-action"));
  return box;
}
function facts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return el("pre", valueText(value), "jx-record-value");
  const dl = el("dl", null, "jx-facts");
  for (const [key, entry] of Object.entries(value)) {
    if (entry == null) continue;
    const dd = el("dd");
    if (typeof entry === "object") dd.append(el("pre", valueText(entry)));
    else dd.textContent = typeof entry === "boolean" ? (entry ? L("是", "Yes") : L("否", "No")) : String(entry);
    dl.append(el("dt", fieldNames()[key] || key), dd);
  }
  return dl;
}
function renderBlocks(target, blocks) {
  if (!Array.isArray(blocks)) { target.append(el("pre", valueText(blocks))); return; }
  if (!blocks.length) target.append(el("p", L("此条记录没有正文。", "This record has no body."), "jx-note"));
  for (const block of blocks) {
    if (block.kind === "text") target.append(readableText(block.text));
    else if (block.kind === "tool_call" || block.kind === "tool_result") {
      const call = block.kind === "tool_call", label = call ? L("调用工具", "Tool call") : L("工具结果", "Tool result");
      const details = fold(`${label} · ${block.name || block.call_id || "Tool"}`, "jx-tool-record");
      if (block.is_error) details.firstChild.append(el("span", L("错误", "Error"), "jx-record-status error"));
      if (call) details.append(facts(block.arguments ?? block.arguments_text));
      else details.append(el("pre", valueText(block.output ?? block.text), "jx-tool-output"));
      if (block.pair_status && block.pair_status !== "matched") details.append(el("p", L("调用关联未完整确认", "Call relationship is incomplete"), "jx-note"));
      if (block.call_id) details.append(el("small", block.call_id, "jx-record-id"));
      target.append(details);
    } else if (block.kind === "attachment") {
      const resource = block.resource || {}, details = fold(L("附件引用", "Attachment reference"), "jx-tool-record");
      details.append(facts({ reference: resource.reference, media_type: resource.media_type, availability: resource.availability })); target.append(details);
    } else {
      const label = block.kind === "reasoning" ? L("思考记录", "Reasoning record") : block.name || block.native_type || L("附加记录", "Additional record");
      const details = fold(label, "jx-tool-record");
      details.append(block.text ? readableText(block.text) : facts(block.output ?? block)); target.append(details);
    }
  }
}
function supplemental(message) {
  return message.is_meta || ["system", "developer", "unknown"].includes(message.role)
    || (message.content?.length === 1 && message.content[0].kind === "text" && /^\s*<environment_context>[\s\S]*<\/environment_context>\s*$/.test(message.content[0].text || ""));
}

export function createContextReader(meta, { request, valid }) {
  const root = el("section", null, "jx-reader"), r = meta.revision, environment = r.normalized?.extensions?.["junction.environment/1"];
  const groups = Object.entries(environment?.groups || {}), count = groups.reduce((sum, [, g]) => sum + (g.items?.length || 0), 0);
  const metrics = el("div", null, "jx-reader-stats");
  for (const [number, label] of [[r.message_count, L("条记录", "records")], [r.turn_count, L("轮对话", "turns")], [count, L("项环境信息", "environment items")]]) {
    const metric = el("span"); metric.append(el("strong", number ?? "—"), document.createTextNode(" " + label)); metrics.append(metric);
  }
  root.append(metrics);
  const tabs = el("div", null, "jx-reader-tabs"); tabs.setAttribute("aria-label", L("Context 内容", "Context contents"));
  const panels = {}, buttons = {}; let started = false, cursor = null, pageRequest = 0, view = "conversation";
  const alive = () => valid() && root.isConnected;
  for (const [key, label] of [["conversation", L("对话", "Conversation")], ["environment", L("环境", "Environment")], ["info", L("信息", "Information")]]) {
    const panel = panels[key] = el("div", null, "jx-reader-panel"); panel.hidden = key !== "conversation";
    const b = buttons[key] = action(label, () => {
      for (const name of Object.keys(panels)) { panels[name].hidden = name !== key; buttons[name].setAttribute("aria-pressed", String(name === key)); }
    });
    b.setAttribute("aria-pressed", String(key === "conversation")); tabs.append(b);
  }
  root.append(tabs, ...Object.values(panels));
  const toolbar = el("div", null, "jx-history-toolbar"), filter = el("select");
  filter.setAttribute("aria-label", L("记录范围", "Record scope"));
  filter.append(new Option(L("用户与 Agent", "User and agent"), "conversation"), new Option(L("全部记录", "All records"), "trace"));
  const progress = el("span", "", "jx-meta"); progress.setAttribute("role", "status");
  toolbar.append(filter, progress);
  const messages = el("div", null, "jx-message-list"), more = action(L("继续读取", "Load more"), () => load(true), "sec jx-load-more"); more.hidden = true;
  panels.conversation.append(toolbar, messages, more);
  filter.onchange = () => { view = filter.value; load(false); };
  let loadedCount = 0;
  async function fullContent(message, body, button) {
    button.disabled = true; button.textContent = L("读取中…", "Loading…");
    try {
      let offset = 0, chunks = [];
      do {
        const chunk = await request(`/messages/${message.id}/content?offset=${offset}`);
        if (!alive() || !body.isConnected) return;
        chunks.push(chunk.text);
        if (chunk.next_offset !== null && !(chunk.next_offset > offset)) throw new Error(L("内容分页异常，请重试。", "Invalid content pagination. Retry."));
        offset = chunk.next_offset;
      } while (offset !== null);
      const content = JSON.parse(chunks.join(""));
      body.replaceChildren(); renderBlocks(body, content);
    } catch (error) {
      if (!alive() || !body.isConnected) return;
      button.disabled = false; button.textContent = L("读取失败，点击重试", "Failed to load. Retry"); button.title = error.message;
    }
  }
  function messageCard(message) {
    const extra = supplemental(message), label = roleNames()[message.role] || message.role;
    const card = el(extra ? "details" : "article", null, extra ? "jx-system-record" : `jx-conversation-message jx-role-${message.role}`);
    const head = el(extra ? "summary" : "header", null, "jx-message-head");
    const author = el("span", label, "jx-message-author");
    head.append(author);
    if (extra) head.append(el("span", message.content?.find(b => b.name)?.name || L("背景与运行信息", "Background and runtime information"), "jx-system-label"));
    const time = dateText(message.timestamp); if (time) { const stamp = el("time", time); stamp.dateTime = message.timestamp; head.append(stamp); }
    const body = el("div", null, "jx-message-body");
    if (message.content_truncated) {
      body.append(el("p", `${L("较长记录", "Long record")} · ${Number(message.content_chars || 0).toLocaleString()} ${L("字符", "characters")}`, "jx-note"));
      const b = action(L("读取完整内容", "Read full content"), () => fullContent(message, body, b), "jx-text-action"); body.append(b);
    } else renderBlocks(body, message.content);
    const provenance = fold(L("记录详情", "Record details"), "jx-message-provenance");
    provenance.append(facts({ message: message.id, turn: message.turn_id, role: message.role, timestamp: message.timestamp, source: message.source }));
    card.append(head, body, provenance); return card;
  }
  async function load(append) {
    const ticket = ++pageRequest, q = new URLSearchParams({ limit: "20", view });
    if (append && cursor) q.set("cursor", cursor);
    more.disabled = true; messages.setAttribute("aria-busy", "true");
    if (!append) { loadedCount = 0; cursor = null; more.hidden = true; messages.replaceChildren(el("p", L("正在读取对话…", "Loading conversation…"), "jx-reader-empty")); }
    progress.textContent = L("读取中…", "Loading…");
    try {
      const page = await request(`/messages?${q}`);
      if (!alive() || ticket !== pageRequest) return;
      if (!append) messages.replaceChildren();
      const fragment = document.createDocumentFragment();
      for (const message of page.items) fragment.append(messageCard(message));
      messages.append(fragment); loadedCount += page.items.length;
      if (!loadedCount) messages.append(el("p", L("这里还没有对话，可切换到全部记录查看。", "No conversation here yet. Try all records."), "jx-reader-empty"));
      cursor = page.next_cursor; more.hidden = !cursor; more.textContent = L("继续读取", "Load more");
      progress.textContent = `${L("已读", "Loaded")} ${loadedCount} ${L("条", "records")}${cursor ? "" : L(" · 已到末尾", " · End")}`;
    } catch (error) {
      if (!alive() || ticket !== pageRequest) return;
      if (!append) messages.replaceChildren();
      progress.textContent = L("读取失败", "Could not load");
      const retry = el("div", null, "jx-reader-empty"); retry.append(el("p", error.message), action(L("重试", "Retry"), () => { retry.remove(); load(append); })); messages.append(retry);
    } finally {
      if (ticket === pageRequest) { more.disabled = false; messages.setAttribute("aria-busy", "false"); }
    }
  }
  panels.environment.append(el("p", L("分享时的环境记录；当前设备是否可用，由接续 Agent 核对。", "Environment at the time of sharing. The receiving agent checks availability on this device."), "jx-note"));
  if (!groups.length) panels.environment.append(el("p", L("此版本没有环境清单。", "No environment manifest in this version."), "jx-reader-empty"));
  for (const [key, group] of groups) {
    const row = fold("", "jx-environment-group"), summary = row.firstChild;
    summary.append(el("strong", groupNames()[key] || key));
    const coverage = el("span", coverageNames()[group.coverage] || group.coverage, "jx-coverage"); coverage.dataset.coverage = group.coverage;
    summary.append(coverage, el("span", group.items?.length ? String(group.items.length) : "—", "jx-environment-count"));
    if (["system", "workspace", "runtimes", "agent"].includes(key) && group.items?.length) row.open = true;
    for (const item of group.items || []) {
      const entry = el("div", null, "jx-environment-item"), observed = item.observed || {};
      const name = el("div", null, "jx-environment-name"); name.append(el("strong", item.id), el("span", statusNames()[observed.status] || observed.status || "", "jx-meta"));
      entry.append(name, facts(observed.value));
      if (observed.source || item.required || observed.reason) {
        const evidence = fold(L("采集依据", "Evidence"), "jx-message-provenance"); evidence.append(facts({ source: observed.source, required: item.required, reason: observed.reason })); entry.append(evidence);
      }
      row.append(entry);
    }
    const workspace = key === "workspace" && r.normalized?.extensions?.[group.reference];
    if (workspace) row.append(facts({ cwd: workspace.cwd, repo_name: workspace.repo_name, branch: workspace.branch, commit: workspace.commit, dirty: workspace.dirty }));
    else if (!group.items?.length) row.append(el("p", L("未记录具体项目。", "No items recorded."), "jx-note"));
    panels.environment.append(row);
  }
  return { element: root, info: panels.info, activate() { if (!started) { started = true; load(false); } } };
}
