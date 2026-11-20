import path from "node:path";

// Working files live outside task metadata and release directories. Deleting a
// task record or upgrading the node must not remove a directory task's output.
export function workspaceLayout(dataDir: string, workspaceRoot?: string) {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : path.resolve(dataDir, "workspaces");
  return { root, tasks: path.join(root, "tasks"), repos: path.join(root, "repos") };
}

export function managedTaskDirectory(dataDir: string, taskId: number, workspaceRoot?: string) {
  return path.join(workspaceLayout(dataDir, workspaceRoot).tasks, String(taskId));
}

export function repositoryTaskDirectory(dataDir: string, repoId: number, repoName: string, taskId: number, workspaceRoot?: string) {
  const name = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "repo";
  return path.join(workspaceLayout(dataDir, workspaceRoot).repos, `${repoId}-${name}`, String(taskId));
}
