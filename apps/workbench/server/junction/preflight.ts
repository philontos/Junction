import type { Runner } from "../fleet/runner.js";
import type { Task } from "../core/db.js";
import { taskCwd } from "../task/workspace.js";

export interface ShareCheck {
  schema_version: "junction.share-check/1";
  checked_at: string;
  task_id: number;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  changed_files: string[];
  changed_count: number;
  publication: "published" | "unpublished" | "unknown" | "not_applicable";
  notes: string[];
}
/** Read-only. No staging, commits, fetches or pushes are performed by sharing. */
export async function checkShare(runner: Runner, task: Task): Promise<ShareCheck> {
  const report: ShareCheck = { schema_version: "junction.share-check/1", checked_at: new Date().toISOString(), task_id: task.id,
    branch: null, commit: null, dirty: null, changed_files: [], changed_count: 0, publication: "unknown", notes: [] };
  const signal = AbortSignal.timeout(12_000);
  const git = (args: string[]) => runner.exec("git", args, { cwd: taskCwd(task), timeoutMs: 8000, signal,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" } });
  try { report.commit = (await git(["rev-parse", "HEAD"])).trim(); }
  catch {
    if (task.kind === "directory") {
      const isRepo = await git(["rev-parse", "--git-dir"]).then(() => true).catch(() => false);
      if (!isRepo) { report.publication = "not_applicable"; return report; }
    }
    report.notes.push("无法确认当前代码提交；共享后可能需要重新准备代码。"); return report;
  }
  const local = await Promise.allSettled([git(["symbolic-ref", "--quiet", "--short", "HEAD"]), git(["status", "--porcelain=v1", "-z"])]);
  report.branch = local[0].status === "fulfilled" ? local[0].value.trim() : null;
  if (local[1].status === "fulfilled") {
    const fields = local[1].value.split("\0").filter(Boolean), files: string[] = [];
    for (let i = 0; i < fields.length; i++) { const row = fields[i]; files.push(row.slice(3)); if (/[RC]/.test(row.slice(0, 2))) i++; }
    report.changed_count = files.length; report.changed_files = files.slice(0, 30); report.dirty = files.length > 0;
    if (report.dirty) report.notes.push(`有 ${files.length} 个未提交文件，文件内容不会随 Context 上传。请先在任务分支提交并推送，或仅共享历史。`);
  } else report.notes.push("无法读取工作区状态，未提交文件是否存在尚未确认。");
  try {
    const refs = (await git(["ls-remote", "--heads", "origin"])).split("\n").filter(Boolean).map(line => line.split(/\s+/));
    const tips = [...new Set(refs.map(row => row[0]).filter(sha => /^[a-f0-9]{40,64}$/i.test(sha)))];
    if (tips.includes(report.commit!)) report.publication = "published";
    else {
      // A commit can be reachable through another branch. Verify with objects
      // already available locally; absence of evidence remains unknown.
      let allKnown = tips.length <= 20;
      for (const tip of tips.slice(0, 20)) {
        if (!await git(["cat-file", "-e", `${tip}^{commit}`]).then(() => true).catch(() => false)) { allKnown = false; continue; }
        if (await git(["merge-base", "--is-ancestor", report.commit!, tip]).then(() => true).catch(() => false)) { report.publication = "published"; break; }
      }
      if (report.publication !== "published") report.publication = allKnown ? "unpublished" : "unknown";
    }
  } catch { /* Missing remote, credentials or network are reported honestly. */ }
  if (report.publication === "unpublished") report.notes.push("当前提交尚未在远程分支中确认，请先推送；其他设备可能无法恢复这一代码版本。");
  if (report.publication === "unknown") report.notes.push("暂时无法确认远程可获取当前提交，请检查仓库地址、网络或 Git 权限。");
  return report;
}
