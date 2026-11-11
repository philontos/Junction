import express, { type Express, type Request, type Response, type NextFunction } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { db, type Repo, type Task, type Provider } from "../core/db.js";
import { DATA_DIR, NS } from "../core/paths.js";
import { getRepo, getTask, getProvider, providerEnv, syncTaskManifest } from "../http/context.js";
import { localRunner } from "../fleet/runner.js";
import { buildRepoTaskEnv } from "../repo/repoenv.js";
import { createRepoTask } from "../task/createtask.js";
import { locateNativeJsonl } from "../session/transcript.js";
import { JunctionClient, JunctionError, readConfig, revisionPath } from "./client.js";
import { WORKSPACE_EXTENSION, workspaceOf, publicRepoUrl, repoIdentity, writeHandoff, handoffPrompt } from "./handoff.js";

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
    if (error instanceof JunctionError) res.status(error.status).json({ error: error.message });
    else { console.error("Junction operation failed:", error instanceof Error ? error.name : "Error"); res.status(500).json({ error: "Junction 操作失败，请查看本机服务日志。" }); }
  }
};
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max ? v : "";
const git = (cwd: string, args: string[]) => localRunner.exec("git", args, { cwd, timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: "0" } });
async function taskSource(id: unknown) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new JunctionError(400, "任务 ID 无效。");
  const task = getTask.get(Number(id)) as Task | undefined;
  if (!task || task.kind === "local") throw new JunctionError(404, "找不到本机仓库任务。");
  if (!["claude", "codex"].includes(task.agent)) throw new JunctionError(409, "当前仅支持 Claude Code 和 Codex JSONL。");
  if (!task.worktree_path || !(await localRunner.exists(task.worktree_path))) throw new JunctionError(409, "工作区已移除；请使用导入 JSONL 来归档历史。");
  const repo = getRepo.get(task.repo_id) as Repo;
  const file = await locateNativeJsonl(localRunner, task);
  if (!file) throw new JunctionError(409, "尚未找到该任务的 JSONL；请先启动 Agent 并进行一次对话。");
  let stat;
  try { stat = await fs.stat(file); } catch { throw new JunctionError(409, "会话 JSONL 尚不存在。"); }
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || !stat.size) throw new JunctionError(413, "JSONL 必须是 1 字节至 32 MiB 的文件。");
  const [commit, branch, status] = await Promise.all([
    git(task.worktree_path, ["rev-parse", "HEAD"]),
    git(task.worktree_path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(task.worktree_path, ["status", "--porcelain"]),
  ]);
  let derivedFrom;
  try { const m = JSON.parse(await fs.readFile(path.join(task.worktree_path, ".tdsp/context/manifest.json"), "utf8"));
    derivedFrom = { context_id: m.context_id, revision_id: m.revision_id }; } catch { /* ordinary task */ }
  return { task, file, bytes: stat.size, workspace: {
    source: { node_id: NS, task_id: task.id }, repo_url: publicRepoUrl(repo.git_url), repo_name: repo.name,
    branch: branch.trim(), commit: commit.trim(), dirty: !!status.trim(),
    ...(derivedFrom ? { derived_from: derivedFrom } : {}),
  } };
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
  app.get("/api/junction/status", wrap(async (req, res) => {
    const client = clientFor(req);
    const me = await client.request("/v1/me");
    res.json({ configured: true, url: client.config.url, node_id: NS, account: client.account.id,
      accounts: client.config.accounts.map(({ id, label }) => ({ id, label })), user_id: me.user_id });
  }));
  app.get("/api/junction/contexts", wrap(async (req, res) => {
    const q = new URLSearchParams({ limit: "20" });
    if (typeof req.query.cursor === "string") q.set("cursor", req.query.cursor);
    res.json(await clientFor(req).request(`/v1/contexts?${q}`));
  }));
  app.get("/api/junction/contexts/:cid/revisions", wrap(async (req, res) => {
    revisionPath(req.params.cid, req.params.cid);
    const q = new URLSearchParams({ limit: "100" });
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
  app.get("/api/junction/tasks/:id/preview", wrap(async (req, res) => {
    const src = await taskSource(req.params.id);
    res.json({ task_id: src.task.id, title: src.task.title, provider: src.task.agent, source_name: path.basename(src.file), bytes: src.bytes, workspace: src.workspace });
  }));
  app.post("/api/junction/publish", wrap(async (req, res) => {
    const client = clientFor(req);
    const src = await taskSource(req.body?.task_id);
    const q = new URLSearchParams({ provider: src.task.agent, source_name: path.basename(src.file),
      title: src.task.title.slice(0, 200), extensions: JSON.stringify({ [WORKSPACE_EXTENSION]: src.workspace }) });
    if (req.body.context_id) {
      const id = str(req.body.context_id, 36);
      revisionPath(id, id); q.set("context_id", id);
    }
    const result = await client.request(`/v1/imports?${q}`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: new Uint8Array(await sourceBytes(src.file, src.bytes)).buffer });
    res.status(result.reused ? 200 : 201).json(result);
  }));
  // Explicit file selection supports pre-existing logs without arbitrary server filesystem access.
  app.post("/api/junction/import", express.raw({ type: "application/x-ndjson", limit: "32mb" }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new JunctionError(415, "请选择 JSONL 文件。");
    if (!["claude", "codex"].includes(String(req.query.provider))) throw new JunctionError(400, "请选择 Claude 或 Codex。");
    const q = new URLSearchParams({ provider: String(req.query.provider), source_name: str(req.query.name, 255) || "upload.jsonl", title: str(req.query.title, 200) || "导入的 Context" });
    const result = await clientFor(req).request(`/v1/imports?${q}`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: new Uint8Array(req.body).buffer });
    res.status(result.reused ? 200 : 201).json(result);
  }));
  app.post("/api/junction/continue", wrap(async (req, res) => {
    const b = req.body || {};
    const client = clientFor(req);
    const repo = getRepo.get(Number(b.repo_id)) as Repo | undefined;
    if (!repo?.mirror_path || repo.status !== "ready") throw new JunctionError(409, "请选择本机已就绪的仓库。");
    if (!["claude", "codex"].includes(b.agent)) throw new JunctionError(400, "请选择 Claude Code 或 Codex。");
    const snapshot = await client.snapshot(b.context_id, b.revision_id);
    if (snapshot.meta.revision.status === "failed") throw new JunctionError(409, "该 Context 解析失败，不能接续。");
    const w = workspaceOf(snapshot.normalized);
    if (w && repoIdentity(w.repo_url) !== repoIdentity(repo.git_url)) throw new JunctionError(409, "目标仓库与 Context 的来源仓库不一致。");
    if ((w?.dirty || !w || snapshot.meta.revision.status !== "ready") && b.acknowledge !== true) {
      throw new JunctionError(409, "请确认未提交代码、缺失环境或解析诊断，再接续任务。");
    }
    const baseBranch = w?.commit || str(b.base_branch, 200) || repo.default_branch;
    if (!baseBranch || baseBranch.startsWith("-")) throw new JunctionError(400, "起始分支无效。");
    if (w) {
      try { await git(repo.mirror_path, ["cat-file", "-e", `${w.commit}^{commit}`]); }
      catch {
        try { await git(repo.mirror_path, ["fetch", "--no-tags", "origin", w.commit]); }
        catch { throw new JunctionError(409, "目标仓库没有此提交；请先推送来源分支并同步仓库，或回原设备继续。"); }
      }
    }
    const provider = b.agent === "claude" && b.provider_id ? getProvider.get(Number(b.provider_id)) as Provider | undefined : undefined;
    if (b.provider_id && !provider) throw new JunctionError(400, "模型后端不存在。");
    const env = buildRepoTaskEnv({ db, ns: NS, runner: localRunner, writeManifest: syncTaskManifest });
    const originalSetup = env.setupWorktree;
    env.setupWorktree = async args => {
      const sha = await originalSetup(w ? { ...args, baseBranch: w.commit } : args);
      if (w && sha !== w.commit) throw new JunctionError(409, "工作区提交与共享快照不一致。");
      return sha;
    };
    const originalStart = env.startSession;
    env.startSession = async (session, worktree, opening, options) => {
      const manifest = writeHandoff(worktree, snapshot, client.config.url);
      // A node-local durable provenance record survives worktree cleanup.
      const taskId = Number(session.split("-")[2]);
      const taskDir = path.join(DATA_DIR, "tasks", String(taskId));
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, "context.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await originalStart(session, worktree, opening, options);
    };
    const result = await createRepoTask(env, { id: repo.id, name: repo.name, mirror_path: repo.mirror_path }, {
      baseBranch: w?.branch || baseBranch, title: str(b.title, 200).trim() || `接续：${snapshot.meta.title}`.slice(0, 200),
      prompt: handoffPrompt(str(b.prompt, 8000)), agent: b.agent, model: str(b.agent_model, 100) || null,
      providerId: provider?.id, env: providerEnv(provider),
    });
    if (!result.ok) throw new JunctionError(409, result.message);
    res.status(201).json({ id: result.id, session: result.session, work_branch: result.workBranch, context_id: b.context_id, revision_id: b.revision_id });
  }));
  app.use("/api/junction", (error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = error?.type === "entity.too.large" ? 413 : error?.type === "entity.parse.failed" ? 400 : 500;
    res.status(status).set("Cache-Control", "no-store").json({ error: status === 413 ? "请求过大；JSONL 最多 32 MiB。" : "请求内容无效。" });
  });
}
