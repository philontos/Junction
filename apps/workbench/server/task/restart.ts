import type Database from "better-sqlite3";
import type { Task, Provider } from "../core/db.js";
import type { Runner } from "../fleet/runner.js";
import { asAgentKind, agentAdapter } from "../session/agent.js";
import { startSession } from "../session/tmux.js";
import { readSessionRuntimes } from "../session/runtime.js";
import { providerEnv } from "../provider/providers.js";
import { startDirectorySession } from "./directory.js";
import { externalReferenceWorktreePaths, TASK_WORKSPACE_INSTRUCTIONS, kimiWorkspaceAgentPath } from "./references.js";

/** Shared by HTTP and tdsp: resume history, or retry a startup that recorded none. */
export async function restartTaskSession(db: Database.Database, runner: Runner, task: Task) {
  const runtime = (await readSessionRuntimes(runner)).get(task.session);
  if (runtime.state === "running") return;
  if (runtime.state === "unknown") throw new Error("暂时无法确认任务进程状态，请稍后重试。");
  const agent = asAgentKind(task.agent);
  let resume = true;
  if (runtime.state === "exited") {
    const located = await agentAdapter(agent).locate({ runner, task, refresh: true });
    // An initial account/auth/network failure may exit before a native session
    // exists. Retry its original opening prompt instead of `resume --last`,
    // which could select another conversation. Existing histories stay intact.
    resume = !!located && await runner.exists(located.file);
  }
  const provider = task.provider_id
    ? db.prepare("SELECT * FROM providers WHERE id=?").get(task.provider_id) as Provider | undefined : undefined;
  const options = { agent, model: task.agent_model, env: providerEnv(provider),
    prompt: resume ? null : task.prompt, restartExited: true };
  if (task.kind === "directory") return startDirectorySession(runner, task, options, resume);
  await startSession(runner, task.session, task.worktree_path, options.prompt, {
    ...options, continue: resume,
    addDirs: externalReferenceWorktreePaths(db, task),
    workspaceInstructions: TASK_WORKSPACE_INSTRUCTIONS,
    kimiAgentFile: kimiWorkspaceAgentPath(task.worktree_path),
  });
}
