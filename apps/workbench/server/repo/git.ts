import path from "node:path";
import crypto from "node:crypto";
import { Runner } from "../fleet/runner.js";

// Runtime Ref creation needs a deadline of its own on the owner node (local
// operations have no SSH transport deadline). Keep it inside the controller's
// 120s remote-node deadline so a useful domain error can still make it back.
export const REFERENCE_GIT_TIMEOUT_MS = 90_000;
export const TASK_GIT_TIMEOUT_MS = 90_000;

export function canonicalGitUrl(value: string): string {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
}

// Run a git command through the given machine's Runner. The env keeps git from
// hanging on an interactive SSH/host-key/credential prompt — fail fast instead.
async function git(
  runner: Runner,
  cwd: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<string> {
  // A bounded Git command must also stop its SSH/credential helper children.
  const boundedSignal = signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
  let sshCommand = process.env.GIT_SSH_COMMAND;
  if (!sshCommand && cwd) {
    // Preserve repository/user routing and identity settings. Overriding
    // core.sshCommand made a working terminal configuration fail in the node.
    sshCommand = await runner.exec("git", ["config", "--get", "core.sshCommand"], {
      cwd, timeoutMs, signal: boundedSignal,
    }).then(value => value.trim()).catch(error => {
      boundedSignal?.throwIfAborted();
      if (error?.code === 1) return ""; // unset
      throw error;
    });
  }
  return runner.exec("git", args, {
    cwd: cwd ?? undefined,
    // extras only — the Runner merges these over the (local or remote) base env.
    env: {
      GIT_SSH_COMMAND: sshCommand ||
        "ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      // Git maps these to libcurl's low-speed guard for HTTPS remotes. The
      // process deadline above remains the final bound for DNS and helpers.
      GIT_HTTP_LOW_SPEED_LIMIT: "1024",
      GIT_HTTP_LOW_SPEED_TIME: "45",
      ...extraEnv,
    },
    timeoutMs,
    signal: boundedSignal,
  });
}

/** Embed token into an https git url for clone/fetch/push. */
export function authUrl(gitUrl: string, token?: string | null): string {
  if (!token) return gitUrl;
  try {
    const u = new URL(gitUrl);
    if (u.protocol !== "https:") return gitUrl;
    // GitLab accepts oauth2:<token>
    u.username = "oauth2";
    u.password = token;
    return u.toString();
  } catch {
    return gitUrl;
  }
}

export function mirrorPath(dataDir: string, repoId: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(dataDir, "mirrors", `${repoId}-${safe}.git`);
}

/**
 * Register a repo locally WITHOUT downloading any objects: create an empty
 * bare repo, point it at origin, and validate connectivity via ls-remote.
 * Objects for a branch are only fetched later, at dispatch time.
 */
export async function initMirror(runner: Runner, gitUrl: string, token: string | null, dest: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await runner.mkdirp(path.dirname(dest));
  if (await runner.exists(dest)) await runner.rmrf(dest);
  await git(runner, null, ["init", "--bare", dest], {}, undefined, signal);
  await git(runner, dest, ["remote", "add", "origin", authUrl(gitUrl, token)], {}, undefined, signal);
  return readRemoteBranches(runner, dest, signal); // throws on bad url/auth/host
}

export interface RemoteBranches {
  branches: string[];
  defaultBranch: string | null;
}

/** Read HEAD and branch names together, without fetching any objects. */
export async function readRemoteBranches(runner: Runner, mirror: string, signal?: AbortSignal): Promise<RemoteBranches> {
  const out = await git(runner, mirror, ["ls-remote", "--symref", "origin", "HEAD", "refs/heads/*"], {}, undefined, signal);
  const branches: string[] = [];
  let defaultBranch: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const head = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line);
    if (head) defaultBranch = head[1];
    const branch = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/i.exec(line);
    if (branch) branches.push(branch[1]);
  }
  return { branches, defaultBranch };
}

export function selectRemoteBranch(remote: RemoteBranches, requested = "", allowFallback = false): string {
  if (requested && remote.branches.includes(requested)) return requested;
  if (requested && !allowFallback) throw new Error(`Branch "${requested}" does not exist on origin`);
  if (remote.defaultBranch && remote.branches.includes(remote.defaultBranch)) return remote.defaultBranch;
  // Some servers do not advertise a symbolic HEAD. A single branch is
  // unambiguous; with multiple branches, require an explicit selection.
  if (remote.branches.length === 1) return remote.branches[0];
  if (!remote.branches.length) throw new Error("Repository has no branches; push an initial commit first");
  throw new Error("Cannot determine the remote default branch; specify an existing branch");
}

/** Live list of remote branches — always current, no local staleness. */
export async function listBranches(runner: Runner, mirror: string): Promise<string[]> {
  return (await readRemoteBranches(runner, mirror)).branches;
}

/**
 * Fetch one branch at dispatch time as a BLOBLESS partial clone
 * (--filter=blob:none): pull the full commit GRAPH but skip file blobs, which
 * git then lazily fetches from the promisor remote on checkout. This stays close
 * to a shallow clone on size/time, but — unlike the old --depth 1 — keeps real
 * ancestry, so merge-base / rebase / "is this an ancestor of master" all work
 * and finishing a task is a normal PR + merge (no bogus "unrelated histories",
 * which --depth 1's parentless boundary commit caused). The first filtered fetch
 * auto-configures origin as the promisor remote. Push/MR still work as before.
 *
 * Lands in the REMOTE-TRACKING ref `refs/remotes/origin/<branch>`, never the local
 * head `refs/heads/<branch>`: the local-head namespace is reserved for per-task
 * WORK branches, each checked out by exactly one worktree, and git refuses to
 * fetch into a checked-out ref — so writing the base there used to break dispatch
 * whenever the base was itself a live task's branch. Tracking refs are never
 * checked out, so this is always safe.
 */
export async function fetchBranch(runner: Runner, mirror: string, branch: string, timeoutMs?: number, signal?: AbortSignal) {
  await git(
    runner,
    mirror,
    ["fetch", "--filter=blob:none", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    {},
    timeoutMs,
    signal,
  );
}

/** Manual full refresh of all branches (the repo card's "fetch" button). Keeps
 *  the blobless filter so refreshing many branches stays light (blobs stay lazy). */
export async function fetchMirror(runner: Runner, mirror: string, gitUrl: string, token: string | null) {
  await git(runner, mirror, ["remote", "set-url", "origin", authUrl(gitUrl, token)]).catch(() => {});
  // into refs/remotes/origin/* (not local heads) for the same reason as fetchBranch:
  // a wildcard into refs/heads/* would refuse the moment any work branch is checked out.
  await git(runner, mirror, ["fetch", "--filter=blob:none", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
}

/** True if `ref` (a full refname) resolves in the mirror. */
async function refExists(runner: Runner, mirror: string, ref: string, signal?: AbortSignal): Promise<boolean> {
  return git(runner, mirror, ["show-ref", "--verify", "--quiet", ref], {}, undefined, signal).then(() => true).catch(error => {
    signal?.throwIfAborted();
    if (error?.code === 1) return false;
    throw error;
  });
}

/** Low-level: create `workBranch` from `startPoint` and check it out at `dest`. */
export async function addWorktree(runner: Runner, mirror: string, dest: string, workBranch: string, startPoint: string, signal?: AbortSignal) {
  await runner.mkdirp(path.dirname(dest));
  await git(runner, mirror, ["worktree", "add", "-b", workBranch, dest, startPoint], {}, undefined, signal);
}

function taskGitError(stage: string, error: any): Error {
  const detail = error?.name === "TimeoutError"
    ? `等待超过 ${TASK_GIT_TIMEOUT_MS / 1000} 秒`
    : String(error?.stderr || error?.message || error).trim().replace(/(https?:\/\/)[^\s/]+@/g, "$1[redacted]@").slice(-1200);
  return new Error(`${stage}：${detail}\n请检查此设备到仓库的网络连接和 Git 认证后重试。`, { cause: error });
}

/** A shared snapshot must start at its recorded commit, never a newer branch tip. */
export async function ensureContextCommit(runner: Runner, mirror: string, commit: string, callerSignal?: AbortSignal) {
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error("Context 提交号无效。");
  const deadline = AbortSignal.timeout(TASK_GIT_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  try {
    // An existence probe on a promisor mirror must stay local: cat-file can
    // otherwise fetch the missing commit (and its full history of blobs).
    await git(runner, mirror, ["cat-file", "-e", `${commit}^{commit}`], { GIT_NO_LAZY_FETCH: "1" }, undefined, signal);
    return;
  } catch { signal.throwIfAborted(); }
  try {
    await git(runner, mirror, ["fetch", "--filter=blob:none", "--no-tags", "origin", commit], {}, undefined, signal);
    await git(runner, mirror, ["cat-file", "-e", `${commit}^{commit}`], { GIT_NO_LAZY_FETCH: "1" }, undefined, signal);
  } catch (error: any) {
    if (/not our ref|unadvertised object|couldn't find remote ref/i.test(String(error?.message))) {
      throw new Error("仓库中找不到 Context 对应的提交。请先在来源设备推送该提交，或回原设备继续。", { cause: error });
    }
    throw taskGitError("无法拉取 Context 对应的提交", error);
  }
}

/**
 * Create a task's worktree from `baseBranch`. Refreshes the base's tracking ref
 * then branches from the fetched commit. Only a verified local branch can be
 * used when fetch fails (so you can fork another task's unpushed work). An old
 * tracking ref must not silently hide a network/authentication failure. The base is only ever a
 * START POINT — never checked out or modified — so any number of tasks can spring
 * from the same branch, even one a live task currently has checked out.
 */
export async function addWorktreeFromBranch(
  runner: Runner, mirror: string, dest: string, workBranch: string, baseBranch: string,
  callerSignal?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(TASK_GIT_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  let startRef = baseBranch;
  if (!/^[0-9a-f]{40,64}$/i.test(baseBranch)) {
    try {
      await fetchBranch(runner, mirror, baseBranch, undefined, signal);
      startRef = `refs/remotes/origin/${baseBranch}`;
    } catch (error) {
      if (signal.aborted || !(await refExists(runner, mirror, `refs/heads/${baseBranch}`, signal))) {
        throw taskGitError(`无法拉取分支 ${baseBranch}`, error);
      }
      startRef = `refs/heads/${baseBranch}`;
    }
  }
  try {
    // Pin before checkout so another fetch cannot move this task's base.
    const commit = (await git(runner, mirror, ["rev-parse", "--verify", "--end-of-options", `${startRef}^{commit}`], {}, undefined, signal)).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error("起始提交不存在或无效。");
    await addWorktree(runner, mirror, dest, workBranch, commit, signal);
  } catch (error) { throw taskGitError("无法创建工作区", error); }
}

/** Create a reference-only checkout for another repository. The selected branch
 * is refreshed into the mirror, resolved once to an immutable commit, and then
 * checked out detached so it never claims or advances a branch. */
export async function addDetachedWorktreeFromBranch(
  runner: Runner, mirror: string, dest: string, baseBranch: string,
): Promise<string> {
  // A reference selected from the repository catalog means the remote branch's
  // current tip. Unlike a primary task base (which may intentionally be an
  // unpushed local work branch), do not silently fall back to stale/local state.
  await fetchBranch(runner, mirror, baseBranch, REFERENCE_GIT_TIMEOUT_MS);
  const startPoint = `origin/${baseBranch}`;
  const commit = (await git(
    runner,
    mirror,
    ["rev-parse", "--verify", `${startPoint}^{commit}`],
    {},
    REFERENCE_GIT_TIMEOUT_MS,
  )).trim();
  if (!commit) throw new Error(`could not resolve reference branch ${baseBranch}`);
  await runner.mkdirp(path.dirname(dest));
  await git(runner, mirror, ["worktree", "add", "--detach", dest, commit], {}, REFERENCE_GIT_TIMEOUT_MS);
  return commit;
}

/** Materialize an immutable, provider-neutral reference snapshot. Unlike a Git
 * linked worktree this directory has no .git pointer and can safely live below
 * the primary task worktree. Materialize through Git's normal worktree checkout:
 * on a blobless partial clone that path batches missing-object prefetches, whereas
 * checkout-index lazily fetches blobs one at a time and can time out on an otherwise
 * healthy remote. Remove the temporary worktree link before atomically publishing
 * the complete directory so agents never observe Git metadata or a partial Ref. */
export async function addReferenceSnapshotFromBranch(
  runner: Runner,
  mirror: string,
  dest: string,
  baseBranch: string,
  callerSignal?: AbortSignal,
): Promise<string> {
  const deadline = AbortSignal.timeout(REFERENCE_GIT_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  await fetchBranch(runner, mirror, baseBranch, REFERENCE_GIT_TIMEOUT_MS, signal);
  const startPoint = `origin/${baseBranch}`;
  const commit = (await git(
    runner,
    mirror,
    ["rev-parse", "--verify", `${startPoint}^{commit}`],
    {},
    REFERENCE_GIT_TIMEOUT_MS,
    signal,
  )).trim();
  if (!commit) throw new Error(`could not resolve reference branch ${baseBranch}`);
  if (await runner.exists(dest)) throw new Error(`reference destination already exists: ${dest}`);

  const parent = path.dirname(dest);
  const token = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const staging = path.join(parent, `.tmp-${path.basename(dest)}-${token}`);
  await runner.mkdirp(parent);
  try {
    await git(
      runner,
      mirror,
      ["worktree", "add", "--detach", staging, commit],
      {},
      REFERENCE_GIT_TIMEOUT_MS,
      signal,
    );
    // The checkout above is only a batching mechanism. The published Ref is a
    // plain snapshot, not a linked worktree, so discard its pointer before the
    // atomic rename. The finally-prune removes the matching common-dir record.
    await runner.rmrf(path.join(staging, ".git"));
    if (runner.rename) await runner.rename(staging, dest);
    else await runner.exec("mv", [staging, dest]);
    return commit;
  } finally {
    await runner.rmrf(staging).catch(() => {});
    // Also repairs a worktree-add that was interrupted after registering its
    // temporary path. Never let best-effort metadata cleanup hide the real error.
    await git(
      runner,
      mirror,
      ["worktree", "prune", "--expire=now"],
      {},
      REFERENCE_GIT_TIMEOUT_MS,
    ).catch(() => {});
  }
}

export async function removeWorktree(runner: Runner, mirror: string, dest: string, workBranch?: string) {
  await git(runner, mirror, ["worktree", "remove", "--force", dest]).catch(async () => {
    // fall back to manual cleanup if worktree metadata is gone
    if (await runner.exists(dest)) await runner.rmrf(dest);
  });
  await git(runner, mirror, ["worktree", "prune"]).catch(() => {});
  if (workBranch) {
    await git(runner, mirror, ["branch", "-D", workBranch]).catch(() => {});
  }
}
