import { api } from "./dom.js";

// Cloud-served UI can be newer than an installed node. Check the destination,
// so an old node cannot misinterpret a directory task as a repository dispatch.
export async function requireDirectoryTasks() {
  try {
    const options = await api("/api/tasks/options");
    if (options.directory_tasks) return options;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  throw new Error(I18N.lang === "zh"
    ? "此设备的本地节点需要更新。请回到设备页面，重新运行安装命令；已有任务会保留。"
    : "Update this device's local node from the devices page by running the installer again. Existing tasks are kept.");
}
