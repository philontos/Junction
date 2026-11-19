import path from "node:path";
import type { Task } from "./types.js";

export const taskCwd = (task: Pick<Task, "kind" | "cwd" | "worktree_path">) =>
  task.kind === "directory" || task.kind === "local" ? task.cwd || "" : task.worktree_path;
export const taskMarker = (task: Pick<Task, "session">) => `[Switchyard task ${task.session}]`;
export const taskControlDir = (dataDir: string, task: Pick<Task, "id" | "kind" | "worktree_path">) =>
  task.kind === "directory" ? path.join(dataDir, "tasks", String(task.id)) : task.worktree_path;
