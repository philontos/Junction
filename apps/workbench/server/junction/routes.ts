import express, { type Express, type Request, type Response, type NextFunction } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { db, type Repo, type Task } from "../core/db.js";
import { DATA_DIR, NS } from "../core/paths.js";
import { getRepo, getTask } from "../http/context.js";
import { localRunner } from "../fleet/runner.js";
import { taskControlDir, taskCwd } from "../task/workspace.js";
import { locateNativeJsonl } from "../session/transcript.js";
import { canShareAgent } from "../session/agent.js";
import { JunctionClient, JunctionError, readConfig, revisionPath } from "./client.js";
import { WORKSPACE_EXTENSION, publicRepoUrl } from "./handoff.js";
import type { ContinuationProgress } from "./repository.js";
import { continueContext, ContinuationError } from "./continuation.js";
import { captureReferences, REPOSITORIES_EXTENSION } from "./references.js";
import { checkShare } from "./preflight.js";
import { readContinuationReport } from "./report.js";
import { getOwnedTask } from "../core/ownership.js";
import { collectEnvironment, ENVIRONMENT_EXTENSION } from "./environment-runtime.mjs";
import { pinEnvironment } from "./environment.js";
import { connectionInfo, connectJunction } from "./connection.js";

const configFile = () => process.env.SWITCHYARD_JUNCTION_CONFIG || path.join(DATA_DIR, "junction.json");
const clientFor = (req: Request) => new JunctionClient(readConfig(configFile()), String(req.headers["x-junction-account"] || "") || undefined);
const wrap = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "GET" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      throw new JunctionError(403, "跨站请求被拒绝。");
    }
    await fn(req, res);
  } catch (error) {
    if (error instanceof JunctionError) res.status(error.status).json({ error: error.message,
      ...(error instanceof ContinuationError && error.report ? { report: error.report } : {}) });
    else { console.error("Junction operation failed:", error instanceof Error ? error.name : "Error"); res.status(500).json({ error: "Junction 操作失败，请查看本机服务日志。" }); }
  }
};
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max ? v : "";
const git = (cwd: string, args: string[]) => localRunner.exec("git", args, { cwd, timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: "0" } });
async function taskSource(id: unknown) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new JunctionError(400, "任务 ID 无效。");
  const task = getTask.get(Number(id)) as Task | undefined;
  if (!task || task.kind === "local") throw new JunctionError(404, "找不到本机 Agent 任务。");
  if (!canShareAgent(task.agent)) throw new JunctionError(409, "该 Agent 尚未安装 Context 共享适配器。");
  const repo = getRepo.get(task.repo_id) as Repo | undefined;
  const cwd = taskCwd(task);
  const file = await locateNativeJsonl(localRunner, task);
  if (!file) throw new JunctionError(409, "尚未找到该任务的 JSONL；请先启动 Agent 并进行一次对话。");
  let stat;
  try { stat = await fs.stat(file); } catch { throw new JunctionError(409, "会话 JSONL 尚不存在。"); }
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || !stat.size) throw new JunctionError(413, "JSONL 必须是 1 字节至 32 MiB 的文件。");
  const checks = await Promise.allSettled([
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["status", "--porcelain"]),
  ]);
  const values = checks.map(r => r.status === "fulfilled" ? r.value.trim() : null);
  const [commit, branch, dirty] = values;
  const remoteUrl = repo?.git_url || (commit ? await git(cwd, ["remote", "get-url", "origin"]).then(value => value.trim()).catch(() => null) : null);
  const notes: { code: string; detail: string }[] = [];
  for (const [i, field] of ["commit", "branch", "dirty"].entries()) {
    if (values[i] === null) notes.push({ code: `${field}_unavailable`, detail: `无法读取当前 ${field}，已标记缺失。` });
  }
  if (dirty) notes.push({ code: "uncommitted_code_not_included", detail: "已记录未提交状态；代码改动不随 Context 上传。" });
  let derivedFrom;
  try { const recorded = await fs.readFile(path.join(taskControlDir(DATA_DIR, task), ".tdsp/context/manifest.json"), "utf8")
      .catch(() => fs.readFile(path.join(DATA_DIR, "tasks", String(task.id), "context.json"), "utf8"));
    const m = JSON.parse(recorded);
    derivedFrom = { context_id: m.context_id, revision_id: m.revision_id }; } catch { /* ordinary task */ }
  const capture = {
    source: { node_id: NS, task_id: task.id }, cwd, workspace_kind: task.kind,
    ...(task.kind === "directory" ? { cwd_mode: task.cwd_mode || "existing" } : {}),
    repo_url: remoteUrl ? publicRepoUrl(remoteUrl) : null, repo_name: repo?.name ?? (remoteUrl ? path.basename(cwd) : null),
    branch, commit, dirty: dirty === null ? null : !!dirty,
    ...(derivedFrom ? { derived_from: derivedFrom } : {}),
  };
  const references = captureReferences(db, task.id);
  const workspace = remoteUrl && commit && branch && dirty !== null ? capture : null;
  return { task, file, bytes: stat.size, workspace, capture, notes, references };
}

async function sourceBytes(file: string, size: number) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = await handle.read(buffer, offset, size - offset, offset);
      if (!read.bytesRead) throw new JunctionError(409, "会话文件在读取时发生变化，请重试。");
      offset += read.bytesRead;
    }
    return buffer;
  } finally { await handle.close(); }
}
export function registerJunctionRoutes(app: Express) {
  app.get("/api/junction/connection", wrap(async (_req, res) => res.json(connectionInfo(configFile(), NS))));
  app.post("/api/junction/connection", wrap(async (req, res) => {
    if (!req.is("application/json")) throw new JunctionError(415, "请使用 JSON 连接配置。");
    res.json(await connectJunction(configFile(), NS, req.body));
  }));
  app.get("/api/junction/status", wrap(async (req, res) => {
    const client = clientFor(req);
    const me = await client.request("/v1/me");
    res.json({ configured: true, url: client.config.url, node_id: NS, account: client.account.id,
      accounts: client.config.accounts.map(({ id, label }) => ({ id, label })), user_id: me.user_id, device_id: me.device_id });
  }));
  app.get("/api/junction/contexts", wrap(async (req, res) => {
    const q = new URLSearchParams({ limit: "20", shared_only: "true" });
    if (typeof req.query.cursor === "string") q.set("cursor", req.query.cursor);
    res.json(await clientFor(req).request(`/v1/contexts?${q}`));
  }));
  app.get("/api/junction/contexts/:cid/revisions", wrap(async (req, res) => {
    revisionPath(req.params.cid, req.params.cid);
    const q = new URLSearchParams({ limit: "20", shared_only: "true" });
    if (typeof req.query.cursor === "string") q.set("cursor", req.query.cursor);
    res.json(await clientFor(req).request(`/v1/contexts/${req.params.cid}/revisions?${q}`));
  }));
  const base = "/api/junction/contexts/:cid/revisions/:rid";
  app.get(base, wrap(async (req, res) => res.json(await clientFor(req).request(revisionPath(req.params.cid, req.params.rid)))));
  app.get(base + "/:resource", wrap(async (req, res) => {
    const client = clientFor(req);
    const p = revisionPath(req.params.cid, req.params.rid);
    const resource = req.params.resource;
    if (resource === "export") {
      const snapshot = await client.snapshot(req.params.cid, req.params.rid);
      res.attachment(`context-${req.params.rid}.json`).json(snapshot.normalized); return;
    }
    if (!["messages", "turns", "diagnostics", "grants"].includes(resource)) throw new JunctionError(404, "未知资源。");
    const q = new URLSearchParams();
    for (const key of ["cursor", "view", "turn_id", "tail_turns", "limit"]) if (typeof req.query[key] === "string") q.set(key, req.query[key] as string);
    res.json(await client.request(`${p}/${resource}?${q}`));
  }));
  app.get(base + "/messages/:mid/content", wrap(async (req, res) => {
    if (!/^m[0-9]+$/.test(req.params.mid)) throw new JunctionError(400, "Message ID 无效。");
    const q = new URLSearchParams({ offset: str(req.query.offset, 20) || "0" });
    res.json(await clientFor(req).request(revisionPath(req.params.cid, req.params.rid) + `/messages/${req.params.mid}/content?${q}`));
  }));
  for (const method of ["put", "delete"] as const) app[method](base + "/grants/:user", wrap(async (req, res) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(req.params.user)) throw new JunctionError(400, "用户名无效。");
    const result = await clientFor(req).request(revisionPath(req.params.cid, req.params.rid) + `/grants/${req.params.user}`, {
      method: method.toUpperCase(), headers: { "content-type": "application/json" },
      ...(method === "put" ? { body: JSON.stringify({ include_raw: req.body?.include_raw === true }) } : {}),
    });
    res.json(result || { revoked: true });
  }));
  app.get("/api/junction/tasks/:id/report", wrap(async (req, res) => {
    const task = getOwnedTask(db, Number(req.params.id));
    if (!task) throw new JunctionError(404, "任务不存在。");
    const report = readContinuationReport(db, task.id);
    if (!report) throw new JunctionError(404, "此任务没有环境准备记录。");
    res.json(report);
  }));
  app.get("/api/junction/tasks/:id/preflight", wrap(async (req, res) => {
    const task = getOwnedTask(db, Number(req.params.id));
    if (!task || task.kind === "local") throw new JunctionError(404, "Agent 任务不存在。");
    res.json(await checkShare(localRunner, task));
  }));
  app.get("/api/junction/tasks/:id/preview", wrap(async (req, res) => {
    const src = await taskSource(req.params.id);
    res.json({ task_id: src.task.id, title: src.task.title, provider: src.task.agent, source_name: path.basename(src.file), bytes: src.bytes, workspace: src.workspace, capture: src.capture, notes: src.notes });
  }));
  app.post("/api/junction/publish", wrap(async (req, res) => {
    const streaming = req.query.stream === "1";
    const emit = (event: object) => {
      if (streaming && !res.destroyed) res.write(JSON.stringify({ ...event, time: new Date().toISOString() }) + "\n");
    };
    const progress = (stage: string, message: string) => emit({ type: "progress", stage, message });
    if (streaming) {
      res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
      res.flushHeaders();
    }
    try {
      progress("collect", "正在读取当前任务与会话记录…");
      const client = clientFor(req);
      let src = await taskSource(req.body?.task_id);
      const check = await checkShare(localRunner, src.task);
      if (check.notes.length && req.body?.acknowledge !== true) throw new JunctionError(409, "共享前检查发现未提交修改或代码可获取性未确认，请查看检查结果后继续。");
      src = await taskSource(req.body?.task_id);
      if ((check.commit && src.capture.commit !== check.commit) || (check.dirty !== null && src.capture.dirty !== check.dirty)) throw new JunctionError(409, "检查期间代码状态发生变化，请重新共享以固定最新切片。");
      const raw = await sourceBytes(src.file, src.bytes);
      progress("snapshot", `已固定会话快照，${raw.length} 字节；已记录可用的仓库和分支信息。`);
      for (const item of src.notes) progress("annotation", item.detail);
      const extensions: Record<string, any> = src.workspace ? { [WORKSPACE_EXTENSION]: src.workspace } : { "switchyard.capture/1": { ...src.capture, notes: src.notes } };
      extensions[REPOSITORIES_EXTENSION] = { references: src.references };
      const { checked_at: _checkedAt, changed_files: _changedFiles, ...checkState } = check;
      extensions["junction.share-check/1"] = checkState;
      progress("environment", "正在记录工作环境与任务中使用过的工具…");
      const captured = await collectEnvironment({ cwd: taskCwd(src.task), agent: src.task.agent, raw,
        workspaceExtension: src.workspace ? WORKSPACE_EXTENSION : "switchyard.capture/1" });
      captured.groups.repositories = { coverage: "collected", reference: REPOSITORIES_EXTENSION,
        items: src.references.map(ref => ({ id: ref.alias, observed: { status: ref.repo_url && ref.commit ? "present" : "unknown",
          value: { repo_name: ref.repo_name, commit: ref.commit, mode: ref.mode }, source: { kind: "task_metadata", reference: ref.alias } } })) };
      extensions[ENVIRONMENT_EXTENSION] = await pinEnvironment(
        path.join(DATA_DIR, "tasks", String(src.task.id), "environment-snapshots"), raw, extensions, captured,
      );
      const q = new URLSearchParams({ provider: src.task.agent, source_name: path.basename(src.file), shared: "true", extensions: JSON.stringify(extensions),
        source_key: `switchyard:${NS}:task:${src.task.id}` });
      const title = src.task.title.trim().slice(0, 200);
      if (title) q.set("title", title);
      if (req.body.context_id) {
        const id = str(req.body.context_id, 36); revisionPath(id, id); q.set("context_id", id);
      }
      progress("upload", "正在上传原始会话，由 Junction 整理描述、标记缺失并存储…");
      const result = await client.request(`/v1/imports?${q}`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: new Uint8Array(raw).buffer });
      const overview = result.normalized.extensions?.["junction.overview/1"];
      progress("stored", `${result.reused ? "已复用已有记录" : "已保存原始会话和标准化记录"}；${result.message_count} 条记录，${result.turn_count} 轮对话。`);
      if (overview) progress("overview", `标题与描述已自动整理；缺失字段 ${overview.missing.length} 项，解析说明 ${result.diagnostic_count} 项。`);
      if (result.status === "failed") progress("annotation", "原始资料已保存，但未识别出可接续的对话；已标记解析失败。");
      emit({ type: "complete", result });
      if (!streaming) res.status(result.reused ? 200 : 201).json(result);
    } catch (error) {
      if (!streaming) throw error;
      const code = error instanceof JunctionError ? error.status : 500;
      if (!(error instanceof JunctionError)) console.error("Junction sharing failed:", error instanceof Error ? error.name : "Error");
      const message = error instanceof JunctionError ? error.message : "分享未完成，请重试或查看本机服务日志。";
      emit({ type: "error", status: code, message });
    } finally { if (streaming) res.end(); }
  }));
  // Explicit file selection supports pre-existing logs without arbitrary server filesystem access.
  app.post("/api/junction/import", express.raw({ type: "application/x-ndjson", limit: "32mb" }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new JunctionError(415, "请选择 JSONL 文件。");
    if (!canShareAgent(req.query.provider)) throw new JunctionError(400, "请选择已支持的 Context 格式。");
    const q = new URLSearchParams({ provider: String(req.query.provider), shared: "true", source_name: str(req.query.name, 255) || "upload.jsonl" });
    if (str(req.query.title, 200).trim()) q.set("title", str(req.query.title, 200).trim());
    const result = await clientFor(req).request(`/v1/imports?${q}`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: new Uint8Array(req.body).buffer });
    res.status(result.reused ? 200 : 201).json(result);
  }));
  app.post("/api/junction/continue", wrap(async (req, res) => {
    const streaming = req.query.stream === "1";
    const disconnected = new AbortController();
    const abort = () => { if (!res.writableEnded) disconnected.abort(); };
    res.once("close", abort);
    // Finish preparation inside the local/cloud proxy's 180s request budget.
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(150_000)]);
    const emit = (event: object) => { if (streaming && !res.destroyed) res.write(JSON.stringify(event) + "\n"); };
    let lastProgress = { stage: "context", message: "正在读取 Context…" };
    const progress: ContinuationProgress = (stage, message) => { lastProgress = { stage, message }; emit({ type: "progress", ...lastProgress }); };
    if (streaming) {
      res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
      res.flushHeaders();
    }
    const heartbeat = streaming ? setInterval(() => emit({ type: "progress", ...lastProgress }), 10_000) : undefined;
    try {
      const result = await continueContext(req.body || {}, clientFor(req), progress, signal);
      if (streaming) emit({ type: "complete", result });
      else res.status(201).json(result);
    } catch (error) {
      if (!streaming) throw error;
      const message = error instanceof JunctionError ? error.message : signal.aborted
        ? "准备超时或连接已中断，请检查任务列表后重试。" : "任务创建失败，请重试或查看本机服务日志。";
      if (!(error instanceof JunctionError) && !signal.aborted) console.error("Context continuation failed:", error instanceof Error ? error.name : "Error");
      emit({ type: "error", message, ...(error instanceof ContinuationError && error.report ? { report: error.report } : {}) });
    } finally { clearInterval(heartbeat); res.removeListener("close", abort); if (streaming) res.end(); }
  }));
  app.use("/api/junction", (error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = error?.type === "entity.too.large" ? 413 : error?.type === "entity.parse.failed" ? 400 : 500;
    res.status(status).set("Cache-Control", "no-store").json({ error: status === 413 ? "请求过大；JSONL 最多 32 MiB。" : "请求内容无效。" });
  });
}
