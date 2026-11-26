import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, type Task, type Provider } from "../core/db.js";
import { DATA_DIR, NS } from "../core/paths.js";
import { localRunner } from "../fleet/runner.js";
import { providerEnv } from "../provider/providers.js";
import { syncReposManifest } from "../repo/manifest.js";
import { buildRepoTaskEnv } from "../repo/repoenv.js";
import { createRepoTask } from "../task/createtask.js";
import { buildDirectoryEnv, createDirectoryTask, directoryDestination } from "../task/directory.js";
import { taskControlDir, taskCwd } from "../task/workspace.js";
import { writeTaskManifestFromDb, removeTaskManifest } from "../task/taskmanifest.js";
import { isAgentKind } from "../session/agent.js";
import { JunctionClient, JunctionError } from "./client.js";
import { contextRepository, prepareContextRepository, type ContinuationProgress } from "./repository.js";
import { writeHandoff, handoffPrompt } from "./handoff.js";
import { restoreReferences } from "./references.js";
import { checkEnvironment, ENVIRONMENT_EXTENSION } from "./environment-runtime.mjs";
import { preparationError, saveContinuationReport, type ContinuationReport, type PreparationItem } from "./report.js";

const str = (value: unknown, max: number) => typeof value === "string" && value.length <= max ? value : "";
export class ContinuationError extends JunctionError {
  constructor(message: string, public report?: ContinuationReport) { super(409, message); }
}

/** Shared HTTP/CLI orchestration. Workspace failures are observations, not a
 * reason to discard a readable Context. Cancellation and Agent failures remain
 * real errors; never start a second agent after a launch was attempted. */
export async function continueContext(b: any, client: JunctionClient, progress: ContinuationProgress = () => {}, signal = new AbortController().signal) {
  if (!isAgentKind(b.agent)) throw new JunctionError(400, "请选择有效的 Agent。");
  if (b.references != null && (!Array.isArray(b.references) || b.references.length > 8 || b.references.some((r: any) => !r || typeof r !== "object"))) throw new JunctionError(400, "Ref 清单无效，最多 8 项。");
  const provider = b.agent === "claude" && b.provider_id ? db.prepare("SELECT * FROM providers WHERE id=?").get(Number(b.provider_id)) as Provider | undefined : undefined;
  if (b.provider_id && !provider) throw new JunctionError(400, "模型后端不存在。");
  const automatic = b.workspace_mode === "context";
  if (b.workspace_mode !== undefined && !automatic) throw new JunctionError(400, "工作位置模式无效。");
  if (automatic && (b.repo_id || b.cwd || b.cwd_mode)) throw new JunctionError(400, "自动准备仓库不能同时指定其他工作位置。");
  let destination = !b.repo_id && !automatic ? await directoryDestination(b.cwd, b.cwd_mode) : undefined;
  progress("context", "正在读取 Context…");
  const snapshot = await client.snapshot(b.context_id, b.revision_id, signal);
  if (snapshot.meta.revision.status === "failed") throw new JunctionError(409, "该 Context 解析失败，不能接续。");
  signal.throwIfAborted();
  const items: PreparationItem[] = [{ id: "context", kind: "context", title: "历史 Context", status: snapshot.meta.revision.status === "ready" ? "ready" : "unknown",
    message: snapshot.meta.revision.status === "ready" ? "已加载固定版本。" : "已加载固定版本；部分历史记录或关联尚未解析，需要按原始证据核对。" }];
  const source = snapshot.normalized.extensions?.["switchyard.workspace/1"] || snapshot.normalized.extensions?.["switchyard.capture/1"];
  if (automatic && !source?.repo_url && !source?.commit && !source?.branch && !source?.repo_name) destination = { mode: "managed" };
  if (source?.dirty !== false && (source?.repo_url || source?.commit)) items.push({ id: "source-changes", kind: "workspace", title: "来源未提交修改",
    status: source.dirty === true ? "missing" : "unknown", message: source.dirty === true ? "来源有未提交修改，文件内容没有随 Context 移交。" : "来源工作区是否干净未确认。" });
  const options = { title: str(b.title, 200).trim() || `接续：${snapshot.meta.title}`.slice(0, 200), agent: b.agent,
    model: str(b.agent_model, 100) || null, providerId: provider?.id, env: providerEnv(provider) };
  let report: ContinuationReport | undefined, reportPath: string | undefined;
  let agentAttempted = false;
  const saveReport = async () => {
    if (!report) return;
    await saveContinuationReport(db, DATA_DIR, report);
    if (reportPath) {
      const temporary = reportPath + `.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, reportPath);
    }
  };
  const prepare = async (task: Task) => {
    const control = taskControlDir(DATA_DIR, task);
    const manifest = writeHandoff(control, snapshot, client.config.url, task.kind === "directory" ? taskCwd(task) : undefined, task.id);
    const dir = path.join(DATA_DIR, "tasks", String(task.id));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, "context.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    reportPath = path.join(control, ".tdsp/context/preparation.json");
    report = { schema_version: "junction.continuation/1", task_id: task.id, context_id: b.context_id, revision_id: b.revision_id,
      recorded_at: new Date().toISOString(), mode: task.kind === "repo" ? "repo" : "directory", agent: b.agent, launch: "preparing", cwd: taskCwd(task), items };
    await saveReport();
    items.push(...await restoreReferences({ db, runner: localRunner, task, normalized: snapshot.normalized, selected: b.references,
      syncRepos: syncReposManifest, progress, signal }));
    progress("environment", "正在核对当前环境…");
    try {
      const checks = await checkEnvironment(snapshot.normalized.extensions?.[ENVIRONMENT_EXTENSION], { cwd: taskCwd(task), groups: ["system", "runtimes", "dependencies"] });
      if (!checks.items?.length) items.push({ id: "environment-source", kind: "environment", title: "来源环境清单", status: "unknown", message: "此版本没有可核对的环境清单，请在当前设备按需检查。" });
      for (const [index, check] of (checks.items || []).entries()) {
        items.push({ id: `environment-${index}`, kind: "environment", title: `${check.group || "环境"} · ${check.id || "概要"}`,
          status: check.status === "same" ? "ready" : ["missing", "different", "not_applicable"].includes(check.status) ? check.status : "unknown",
          message: check.status === "same" ? "与来源记录一致。" : check.status === "missing" ? "当前设备缺少此项。" : check.status === "different" ? "与来源版本或文件不同，不代表一定不兼容。" : "尚未确认，按任务需要检查。" });
      }
    } catch (error) { items.push({ id: "environment-check", kind: "environment", title: "环境检查", status: "unknown", message: preparationError(error) }); }
    items.push({ id: "environment-access", kind: "environment", title: "工具、Skills 与访问权限", status: "unknown", message: "使用当前设备的安装与认证；未自动复制或验证全部工具、Skills、MCP、外部服务与凭据，由 Agent 按需核对。" });
    task.prompt = handoffPrompt(str(b.prompt, 8000), task.kind === "directory" ? path.join(control, ".tdsp/context") : ".tdsp/context");
    db.prepare("UPDATE tasks SET prompt=? WHERE id=?").run(task.prompt, task.id);
    writeTaskManifestFromDb(DATA_DIR, db, task.id);
    await saveReport();
  };
  const finished = async (result: any) => {
    report!.launch = "started";
    items.push({ id: "agent", kind: "agent", title: "Agent 进程", status: "ready", message: "已启动；模型登录和后续运行状态以终端为准。" });
    try { await saveReport(); }
    catch {
      // A receipt write failure must not claim that a running Agent failed or
      // invite a duplicate launch. Return the receipt to the current browser.
      items.push({ id: "report-storage", kind: "environment", title: "启动记录保存", status: "unknown", message: "任务已启动，但启动记录未能完整保存，请检查节点存储空间与权限。" });
    }
    return { ...result, context_id: b.context_id, revision_id: b.revision_id, report };
  };
  try {
    if (!destination) {
      try {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(40_000)]);
        const code = contextRepository(snapshot.normalized);
        const repo = await prepareContextRepository({ db, runner: localRunner, syncRepos: syncReposManifest }, code,
          automatic ? undefined : Number(b.repo_id), progress, bounded);
        const base = code.commit || code.branch || repo.default_branch;
        progress("worktree", "正在创建独立分支和 Worktree…");
        let taskId = 0;
        const env = buildRepoTaskEnv({ db, ns: NS, runner: localRunner, signal: bounded, writeManifest: id => writeTaskManifestFromDb(DATA_DIR, db, id) });
        env.onCreated = task => { taskId = task.id; };
        const setup = env.setupWorktree, start = env.startSession;
        env.setupWorktree = async args => {
          const commit = await setup({ ...args, baseBranch: base });
          if (code.commit && commit !== code.commit) throw new Error("工作区提交与共享快照不一致。");
          return commit;
        };
        env.startSession = async (session, worktree, _opening, launchOptions) => {
          const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as Task;
          items.push({ id: "workspace", kind: "workspace", title: "主仓库与 Worktree", status: code.commit ? "ready" : "unknown",
            message: code.commit ? "已按来源固定提交创建独立工作区。" : "来源未记录 commit，使用了分支当前版本。", branch: task.work_branch, commit: task.base_commit, path: worktree });
          // Workspace deadline only covers preparation, not optional references.
          await prepare(task); signal.throwIfAborted();
          progress("agent", "正在启动 Agent…"); agentAttempted = true;
          await start(session, worktree, task.prompt, launchOptions);
        };
        const result = await createRepoTask(env, { id: repo.id, name: repo.name, mirror_path: repo.mirror_path! }, { ...options, baseBranch: code.branch || base });
        if (!result.ok) {
          // A failed worktree allocation has no Agent or history yet. Its own
          // cleanup has finished; keep the fallback as the single visible task.
          if ("id" in result && !report && !agentAttempted) {
            db.prepare("DELETE FROM tasks WHERE id=? AND status='error' AND worktree_path='' AND session=''").run(result.id);
            removeTaskManifest(DATA_DIR, result.id);
          }
          throw new Error(result.message);
        }
        return await finished({ id: result.id, session: result.session, repo_id: repo.id, work_branch: result.workBranch });
      } catch (error) {
        signal.throwIfAborted();
        if (agentAttempted || report) throw error;
        items.push({ id: "workspace", kind: "workspace", title: "主仓库与 Worktree", status: "missing",
          message: `${preparationError(error)} 已改用独立 Agent 目录，原代码尚未恢复。` });
        progress("fallback", "仓库未准备完成，改为启动普通 Agent 任务…");
        destination = { mode: "managed" };
      }
    }
    if (!items.some(i => i.id === "workspace")) items.push({ id: "workspace", kind: "workspace", title: "工作目录",
      status: source?.commit || source?.branch || source?.repo_name ? "missing" : "ready",
      message: source?.commit || source?.branch || source?.repo_name ? "未恢复来源仓库，已准备独立 Agent 目录。" : "已准备独立 Agent 目录。" });
    const env = buildDirectoryEnv(db, NS, localRunner, signal);
    env.prepare = prepare;
    const start = env.start;
    env.start = async (task, opts) => { signal.throwIfAborted(); progress("agent", "正在启动 Agent…"); agentAttempted = true; await start(task, { ...opts, prompt: task.prompt }); };
    const result = await createDirectoryTask(env, { ...options, cwd: destination?.cwd, cwdMode: destination?.mode || "managed" });
    return await finished(result);
  } catch (error) {
    if (report) {
      report.launch = "failed"; items.push({ id: "agent", kind: "agent", title: "Agent 启动", status: "missing", message: preparationError(error) });
      // Repo cleanup may have removed its working copy; the task-owned report survives.
      reportPath = undefined; await saveReport();
    }
    throw new ContinuationError(preparationError(error), report);
  }
}
