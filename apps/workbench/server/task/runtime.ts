import path from "node:path";
import type { Task } from "../core/db.js";
import type { Runner } from "../fleet/runner.js";
import { readSessionRuntimes } from "../session/runtime.js";
import type { TaskLive } from "./cli.js";
import { taskControlDir } from "./workspace.js";

/** The owning node supplies the same observations to HTTP and remote tdsp clients. */
export async function taskLiveness(runner: Runner, tasks: Task[]): Promise<Map<number, TaskLive>> {
  const sessions = await readSessionRuntimes(runner);
  return new Map(await Promise.all(tasks.map(async task => {
    const runtime = task.status === "cleaned" ? { state: "missing" as const } : sessions.get(task.session);
    const alive = runtime.state === "running";
    const [hasWorktree, hasDirectory, waiting] = await Promise.all([
      task.worktree_path ? runner.exists(task.worktree_path).catch(() => false) : false,
      task.kind === "directory" && task.cwd ? runner.exists(task.cwd).catch(() => false) : false,
      alive ? runner.exists(path.join(taskControlDir(runner.dataDir, task), ".claude/waiting")).catch(() => false) : false,
    ]);
    return [task.id, { runtime, alive, hasWorktree, hasDirectory, waiting: waiting && (hasWorktree || hasDirectory) }] as const;
  })));
}
