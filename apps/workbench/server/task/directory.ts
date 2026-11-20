// Directory task output survives task cleanup, whether automatically allocated
// or user-selected. Control files and project settings stay outside the cwd.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { Task } from "../core/db.js";
import { localHostId } from "../core/ownership.js";
import { resolveCwd } from "../fleet/local.js";
import { type Runner } from "../fleet/runner.js";
import { type AgentKind, isAgentKind, agentAdapter } from "../session/agent.js";
import { hookSettingsJson } from "../session/hooks.js";
import { startSession, killSession } from "../session/tmux.js";
import { writeTaskManifestFromDb } from "./taskmanifest.js";
import { taskCwd, taskMarker, taskControlDir } from "./workspace.js";
import { managedTaskDirectory } from "./workspace-layout.js";

export type DirectoryMode = "managed" | "existing";

export interface DirectoryOptions {
  cwd?: string | null;
  cwdMode?: DirectoryMode;
  title?: string | null;
  prompt?: string | null;
  agent: AgentKind;
  model?: string | null;
  providerId?: number | null;
  env?: Record<string, string>;
}
export interface DirectoryEnv {
  db: Database.Database;
  ns: string;
  dataDir: string;
  home?: string;
  // Exposed for isolated integration tests and for pinning a Junction handoff
  // before the first agent process starts.
  prepare?(task: Task): Promise<void>;
  start(task: Task, options: DirectoryOptions): Promise<void>;
  stop(session: string): Promise<void>;
}

export async function directoryCwd(input: unknown, home = os.homedir()): Promise<string> {
  if (input != null && (typeof input !== "string" || input.length > 4096 || input.includes("\0"))) {
    throw new Error("工作目录无效。");
  }
  const cwd = resolveCwd(input as string | undefined, home);
  try {
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error();
    await fs.access(cwd, fs.constants.R_OK | fs.constants.X_OK);
    return await fs.realpath(cwd);
  } catch { throw new Error("工作目录不存在或不可访问，请选择本机已有目录。"); }
}

// Older clients send a cwd without a mode; preserve that contract. Omission
// selects an isolated workspace, never the home directory implicitly.
export async function directoryDestination(input: unknown, mode: unknown, home?: string): Promise<{ mode: DirectoryMode; cwd?: string }> {
  if (input != null && (typeof input !== "string" || input.length > 4096 || input.includes("\0"))) throw new Error("工作目录无效。");
  if (mode != null && mode !== "managed" && mode !== "existing") throw new Error("工作目录模式无效。");
  const supplied = typeof input === "string" && !!input.trim();
  const selected = mode ?? (supplied ? "existing" : "managed");
  if (selected === "managed") {
    if (supplied) throw new Error("独立工作区由系统分配，请勿同时指定已有目录。");
    return { mode: "managed" };
  }
  if (!supplied) throw new Error("请填写本机已有的工作目录。");
  return { mode: "existing", cwd: await directoryCwd(input, home) };
}

export async function createDirectoryTask(env: DirectoryEnv, options: DirectoryOptions) {
  for (const field of [options.title, options.prompt, options.model]) {
    if (field != null && typeof field !== "string") throw new Error("任务标题、指令和模型必须是文本。");
  }
  const destination = await directoryDestination(options.cwd, options.cwdMode, env.home);
  if (!isAgentKind(options.agent)) throw new Error("请选择有效的 Agent。");
  const owner = localHostId(env.db);
  if (owner == null) throw new Error("本机节点未初始化。");
  const title = options.title?.trim().slice(0, 200) || (destination.cwd ? `${options.agent} · ${path.basename(destination.cwd) || destination.cwd}` : "");
  const sid = options.agent === "claude" ? crypto.randomUUID() : null;
  const result = env.db.prepare(
    "INSERT INTO tasks (kind,host_id,repo_id,base_branch,work_branch,title,prompt,worktree_path,session,status,cwd,cwd_mode,agent,agent_model,provider_id,claude_session) " +
    "VALUES ('directory',?,0,'','',?,?,'','','creating',?,?,?,?,?,?)",
  ).run(owner, title, options.prompt || null, destination.cwd || "", destination.mode, options.agent, options.model || null, options.providerId || null, sid);
  const id = Number(result.lastInsertRowid);
  const session = `tdsp-${env.ns}-${id}-directory`;
  let cwd = destination.cwd || managedTaskDirectory(env.dataDir, id);
  env.db.prepare("UPDATE tasks SET session=?,cwd=?,title=? WHERE id=?").run(session, cwd, title || `${options.agent} · #${id}`, id);
  const task = env.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task;
  const manifest = () => writeTaskManifestFromDb(env.dataDir, env.db, id);
  let allocated = destination.mode === "existing";
  try {
    if (destination.mode === "managed") {
      await fs.mkdir(path.dirname(cwd), { recursive: true, mode: 0o700 });
      // Fail on a pre-existing leaf rather than reuse an unrelated directory.
      try { await fs.mkdir(cwd, { mode: 0o700 }); }
      catch (error: any) {
        if (error.code === "EEXIST") throw new Error("任务目录已存在，未覆盖原文件。请重新创建任务。");
        throw error;
      }
      allocated = true;
      cwd = await fs.realpath(cwd);
      task.cwd = cwd;
      env.db.prepare("UPDATE tasks SET cwd=? WHERE id=?").run(cwd, id);
    }
    await fs.mkdir(taskControlDir(env.dataDir, task), { recursive: true, mode: 0o700 });
    manifest();
    await env.prepare?.(task);
    await env.start(task, options);
    env.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(id);
    manifest();
    return { id, session, cwd, cwd_mode: destination.mode };
  } catch (error) {
    await env.stop(session).catch(() => {});
    // A failed allocation must not become resumable in a pre-existing path.
    if (!allocated) env.db.prepare("UPDATE tasks SET cwd=NULL WHERE id=?").run(id);
    env.db.prepare("UPDATE tasks SET status='error',error=? WHERE id=?").run(String((error as Error).message), id);
    manifest();
    throw error;
  }
}

export async function startDirectorySession(runner: Runner, task: Task, options: DirectoryOptions, resume = false) {
  // tmux can outlive installation changes and retain an older PATH. Resolve on
  // the owning node before launching, and report a missing CLI immediately.
  const binary = (await runner.exec("sh", ["-c", 'command -v "$1"', "sh", options.agent]).catch(() => "")).trim();
  if (!path.isAbsolute(binary)) {
    const adapter = agentAdapter(options.agent);
    throw new Error(`本机未找到 ${adapter.name}，请先安装该 Agent CLI。${adapter.installCommand ? `安装命令：${adapter.installCommand}` : ""}`);
  }
  const control = taskControlDir(runner.dataDir, task);
  await fs.mkdir(path.join(control, ".claude"), { recursive: true, mode: 0o700 });
  const settings = path.join(control, ".claude", "settings.local.json");
  await fs.writeFile(settings, hookSettingsJson(control), { mode: 0o600 });
  const instructions = `${taskMarker(task)} Switchyard runs this task in its recorded working directory. ` +
    "This directory is not necessarily a repository. Follow its applicable instructions and verify the current environment before continuing historical work.";
  const kimiFile = path.join(control, "kimi-agent.md");
  await fs.writeFile(kimiFile, `---\nname: switchyard-directory\ndescription: Switchyard directory task\n---\n\n\${base_prompt}\n\n${instructions}\n`, { mode: 0o600 });
  let sessionId = task.claude_session || undefined;
  const resumeId = agentAdapter(options.agent).directoryResumeId;
  if (resume && resumeId) {
    sessionId = await resumeId(runner, task) || undefined;
    if (!sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
      throw new Error("未找到此任务自己的会话记录，无法安全恢复。请新建任务或从共享 Context 接续。");
    }
  }
  await startSession(runner, task.session, taskCwd(task), options.prompt, {
    continue: resume, agent: options.agent, model: options.model, env: options.env,
    workspaceInstructions: instructions, kimiAgentFile: kimiFile,
    sessionId, claudeSettings: settings, binary,
  });
}

export function buildDirectoryEnv(db: Database.Database, ns: string, runner: Runner): DirectoryEnv {
  return { db, ns, dataDir: runner.dataDir, start: (task, options) => startDirectorySession(runner, task, options),
    stop: session => killSession(runner, session) };
}
