import type Database from "better-sqlite3";
import type { Task } from "../core/db.js";
import type { Runner } from "../fleet/runner.js";
import { getOwnedRepo } from "../core/ownership.js";
import { listTaskReferences, type TaskReferenceInput } from "../task/references.js";
import { addTaskReference } from "../task/addreference.js";
import { addReferenceSnapshotFromBranch, addReferenceSnapshotFromCommit, removeWorktree } from "../repo/git.js";
import { writeTaskManifestFromDb } from "../task/taskmanifest.js";
import { publicRepoUrl } from "./handoff.js";
import { prepareContextRepository, type ContinuationProgress } from "./repository.js";
import { preparationError, type PreparationItem } from "./report.js";

export const REPOSITORIES_EXTENSION = "junction.repositories/1";
export interface SharedReference {
  alias: string; repo_url: string | null; repo_name: string;
  requested_ref: string; commit: string; mode: "reference";
}
export function captureReferences(db: Database.Database, taskId: number): SharedReference[] {
  return listTaskReferences(db, taskId).map(r => {
    const repo = getOwnedRepo(db, r.repo_id);
    return { alias: r.alias, repo_url: repo?.git_url ? publicRepoUrl(repo.git_url) : null, repo_name: r.repo_name,
      requested_ref: r.requested_ref, commit: r.resolved_commit, mode: "reference" };
  });
}
export async function restoreReferences(options: {
  db: Database.Database; runner: Runner; task: Task; normalized: any; selected?: TaskReferenceInput[];
  syncRepos(): void; progress: ContinuationProgress; signal: AbortSignal;
}): Promise<PreparationItem[]> {
  const { db, runner, task, normalized, selected = [], syncRepos, progress, signal } = options;
  const items: PreparationItem[] = [];
  const shared = normalized.extensions?.[REPOSITORIES_EXTENSION]?.references;
  if (shared == null) items.push({ id: "reference-capture", kind: "reference", title: "来源参考仓库", status: "unknown", message: "此历史版本未记录 Ref 清单；可在任务中手动添加，或在来源任务重新共享。" });
  if (shared != null && !Array.isArray(shared)) items.push({ id: "references", kind: "reference", title: "参考仓库", status: "missing", message: "来源 Ref 清单格式无效，未自动恢复；仍会准备本次选定的 Ref。" });
  const requests: Array<{ shared?: SharedReference; selected?: TaskReferenceInput }> = [
    ...(Array.isArray(shared) ? shared.slice(0, 8).map(r => ({ shared: r })) : []), ...selected.map(r => ({ selected: r })),
  ];
  const deadline = Date.now() + 45_000;
  if (Array.isArray(shared) && shared.length > 8) items.push({ id: "reference-limit", kind: "reference", title: "参考仓库数量", status: "missing", message: "超出 8 个的来源 Ref 未自动恢复。" });
  for (let index = 0; index < requests.length; index++) {
    signal.throwIfAborted();
    const request = requests[index], source = request.shared;
    const alias = String(source?.alias || request.selected?.alias || `ref-${index + 1}`);
    const item: PreparationItem = { id: `reference-${index}`, kind: "reference", title: alias, alias, status: "missing", message: "" };
    progress("references", `正在准备参考仓库 ${alias}…`);
    try {
      // Bound each optional preparation independently; its timeout must not cancel Agent startup.
      if (Date.now() >= deadline) throw new Error("参考仓库准备达到时间上限，可在任务启动后补充。未阻止 Agent 启动。");
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now())))]);
      let input: TaskReferenceInput;
      if (source) {
        if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(alias) || !/^[0-9a-f]{40,64}$/i.test(source.commit || "")) throw new Error("Ref 别名或固定提交缺失，未用最新分支代替。请在来源任务重新共享。");
        item.repo_url = source.repo_url ? publicRepoUrl(source.repo_url) : undefined;
        item.branch = source.requested_ref; item.commit = source.commit;
        const repo = await prepareContextRepository({ db, runner, syncRepos }, {
          repoUrl: source.repo_url || "", commit: source.commit, branch: source.requested_ref, dirty: false,
        }, undefined, () => {}, bounded);
        input = { repo_id: repo.id, alias, ref: source.commit };
      } else input = request.selected!;
      const result = await addTaskReference({ db, dataDir: runner.dataDir, exists: p => runner.exists(p),
        setupReference: args => source
          ? addReferenceSnapshotFromCommit(runner, args.mirror, args.worktree, source.commit, bounded)
          : addReferenceSnapshotFromBranch(runner, args.mirror, args.worktree, args.requestedRef, bounded),
        removeReference: (mirror, dest) => removeWorktree(runner, mirror, dest).then(() => {}),
        writeManifest: id => writeTaskManifestFromDb(runner.dataDir, db, id),
      }, task.id, input);
      if (!result.ok) throw new Error(result.message);
      if (source && source.requested_ref) {
        db.prepare("UPDATE task_references SET requested_ref=? WHERE task_id=? AND alias=?").run(source.requested_ref, task.id, result.reference.alias);
        writeTaskManifestFromDb(runner.dataDir, db, task.id);
      }
      item.alias = result.reference.alias; item.commit = result.reference.resolved_commit;
      item.path = listTaskReferences(db, task.id).find(r => r.alias === result.reference.alias)?.worktree_path;
      item.status = "ready"; item.message = "固定版本已准备，作为只读参考。";
    } catch (error) {
      signal.throwIfAborted();
      item.message = preparationError(error) || "未能准备，请检查仓库权限和网络。";
    }
    items.push(item);
  }
  return items;
}
