import { createRepoTask, type RepoTaskEnv, type RepoRef, type CreateRepoOpts, type CreateRepoResult } from "./createtask.js";

/** The task row is durable; only live cancellation/progress belongs in memory. */
export class TaskPreparations {
  private jobs = new Map<number, {
    controller: AbortController; stage: string; started_at: number;
    done: Promise<CreateRepoResult>;
  }>();

  progress(id: number) {
    const job = this.jobs.get(id);
    return job ? { stage: job.stage, started_at: job.started_at } : null;
  }

  create(
    build: (signal: AbortSignal, progress: (id: number, stage: string) => void) => RepoTaskEnv,
    repo: RepoRef, opts: CreateRepoOpts,
    accepted?: (task: { id: number; session: string; workBranch: string }) => void,
  ): Promise<CreateRepoResult> {
    const controller = new AbortController();
    let id: number | undefined;
    const job = { controller, stage: "准备工作区", started_at: Date.now(), done: undefined as unknown as Promise<CreateRepoResult> };
    const env = build(controller.signal, (_id, stage) => { job.stage = stage; });
    job.done = createRepoTask({ ...env, signal: controller.signal, onCreated: task => {
      id = task.id; this.jobs.set(id, job); accepted?.(task);
    } }, repo, opts).finally(() => { if (id != null) this.jobs.delete(id); });
    return job.done;
  }

  async cancel(id: number): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.controller.abort(new Error("任务创建已取消。"));
    await job.done;
    return true;
  }
}
