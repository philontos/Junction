// An Agent task owns its session and metadata, but never owns the user's cwd.
// In particular, cleanup must not delete it or install project settings there.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { Task } from "../core/db.js";
import { localHostId } from "../core/ownership.js";
import { resolveCwd } from "../fleet/local.js";
import { type Runner } from "../fleet/runner.js";
import { type AgentKind } from "../session/agent.js";
import { hookSettingsJson } from "../session/hooks.js";
import { startSession, killSession } from "../session/tmux.js";
import { locateNativeJsonl, locateDirectoryKimi } from "../session/transcript.js";
import { writeTaskManifestFromDb } from "./taskmanifest.js";
import { taskCwd, taskMarker, taskControlDir } from "./workspace.js";

export interface DirectoryOptions {
  cwd?: string | null;
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

export async function createDirectoryTask(env: DirectoryEnv, options: DirectoryOptions) {
  for (const field of [options.title, options.prompt, options.model]) {
    if (field != null && typeof field !== "string") throw new Error("任务标题、指令和模型必须是文本。");
  }
  // Validate before recording a task; no mkdir or Git operations on user data.
  const cwd = await directoryCwd(options.cwd, env.home);
  if (!["claude", "codex", "kimi"].includes(options.agent)) throw new Error("请选择有效的 Agent。");
  const owner = localHostId(env.db);
  if (owner == null) throw new Error("本机节点未初始化。");
  const title = options.title?.trim().slice(0, 200) || `${options.agent} · ${path.basename(cwd) || cwd}`;
  const sid = options.agent === "claude" ? crypto.randomUUID() : null;
  const result = env.db.prepare(
    "INSERT INTO tasks (kind,host_id,repo_id,base_branch,work_branch,title,prompt,worktree_path,session,status,cwd,agent,agent_model,provider_id,claude_session) " +
    "VALUES ('directory',?,0,'','',?,?,'','','creating',?,?,?,?,?)",
  ).run(owner, title, options.prompt || null, cwd, options.agent, options.model || null, options.providerId || null, sid);
  const id = Number(result.lastInsertRowid);
  const session = `tdsp-${env.ns}-${id}-directory`;
  env.db.prepare("UPDATE tasks SET session=? WHERE id=?").run(session, id);
  const task = env.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task;
  const manifest = () => writeTaskManifestFromDb(env.dataDir, env.db, id);
  try {
    await fs.mkdir(taskControlDir(env.dataDir, task), { recursive: true, mode: 0o700 });
    manifest();
    await env.prepare?.(task);
    await env.start(task, options);
    env.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(id);
    manifest();
    return { id, session, cwd };
  } catch (error) {
    await env.stop(session).catch(() => {});
    env.db.prepare("UPDATE tasks SET status='error',error=? WHERE id=?").run(String((error as Error).message), id);
    manifest();
    throw error;
  }
}

export async function startDirectorySession(runner: Runner, task: Task, options: DirectoryOptions, resume = false) {
  // tmux can outlive installation changes and retain an older PATH. Resolve on
  // the owning node before launching, and report a missing CLI immediately.
  const binary = (await runner.exec("sh", ["-c", 'command -v "$1"', "sh", options.agent]).catch(() => "")).trim();
  if (!path.isAbsolute(binary)) throw new Error(`本机未找到 ${options.agent}，请先安装该 Agent CLI。`);
  const control = taskControlDir(runner.dataDir, task);
  await fs.mkdir(path.join(control, ".claude"), { recursive: true, mode: 0o700 });
  const settings = path.join(control, ".claude", "settings.local.json");
  await fs.writeFile(settings, hookSettingsJson(control), { mode: 0o600 });
  const instructions = `${taskMarker(task)} Switchyard runs this task in the user-selected working directory. ` +
    "This directory is not necessarily a repository. Follow its applicable instructions and verify the current environment before continuing historical work.";
  const kimiFile = path.join(control, "kimi-agent.md");
  await fs.writeFile(kimiFile, `---\nname: switchyard-directory\ndescription: Switchyard directory task\n---\n\n\${base_prompt}\n\n${instructions}\n`, { mode: 0o600 });
  let sessionId = task.claude_session || undefined;
  if (resume) {
    if (task.agent === "claude") {
      const observed = (await runner.readText(path.join(control, ".claude", "session-id")))?.trim();
      if (observed && /^[a-zA-Z0-9_-]{1,128}$/.test(observed)) sessionId = observed;
    } else if (task.agent === "codex") {
      const file = await locateNativeJsonl(runner, task);
      if (file) {
        const handle = await fs.open(file, "r");
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const meta = JSON.parse(buffer.subarray(0, bytesRead).toString().split("\n")[0]);
          sessionId = meta.payload?.id || meta.payload?.session_id;
        } finally { await handle.close(); }
      }
    } else {
      const found = await locateDirectoryKimi(runner, task);
      sessionId = found?.source.replace(/^kimi:/, "");
    }
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
