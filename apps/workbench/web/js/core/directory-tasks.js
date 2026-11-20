import { api } from "./dom.js";

// Cloud-served UI can be newer than an installed node. Check the destination,
// so an old node cannot misinterpret a directory task as a repository dispatch.
export async function requireDirectoryTasks(managed = false) {
  try {
    const options = await api("/api/tasks/options");
    if (options.directory_tasks && (!managed || options.managed_workspaces)) return options;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  throw new Error(I18N.lang === "zh"
    ? "此设备的本地节点需要更新。请回到设备页面，重新运行安装命令；已有任务会保留。"
    : "Update this device's local node from the devices page by running the installer again. Existing tasks are kept.");
}

// Both new tasks and Context handoffs use the destination node's workspace
// policy. A source Context's absolute cwd is never an implicit destination.
export function populateWorkspaceOptions(select, repos) {
  select.replaceChildren(new Option(I18N.t("task.managedMode"), ""), new Option(I18N.t("task.existingMode"), "directory"));
  const ready = repos.filter(r => r.status === "ready");
  if (ready.length) {
    const group = document.createElement("optgroup"); group.label = I18N.t("task.repoWorkspaces");
    for (const repo of ready) group.append(new Option(repo.name, String(repo.id)));
    select.append(group);
  }
}

export function workspaceSelection(value, cwd) {
  const repo_id = Number(value) || 0;
  if (repo_id) return { repo_id };
  if (value === "directory") {
    const directory = cwd.trim();
    if (!directory) throw new Error(I18N.t("task.cwdRequired"));
    return { repo_id: 0, cwd_mode: "existing", cwd: directory };
  }
  return { repo_id: 0, cwd_mode: "managed" };
}

// HTTPS and SSH URLs may identify the same repository. Names and absolute paths
// alone are not enough to select a destination on a different machine.
export function matchingWorkspaceRepo(repos, sourceUrl) {
  const identity = value => {
    if (typeof value !== "string") return null;
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(value);
    if (scp && !value.includes("://")) return `${scp[1].toLowerCase()}/${scp[2].replace(/\/+$/, "").replace(/\.git$/i, "")}`;
    try {
      const url = new URL(value);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
      return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "")}`;
    } catch { return null; }
  };
  const source = identity(sourceUrl);
  const matches = source ? repos.filter(repo => repo.status === "ready" && identity(repo.git_url) === source) : [];
  return matches.length === 1 ? matches[0] : null;
}
