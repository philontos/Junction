import type { Repo } from "../core/db.js";
import { getOwnedRepo, listOwnedRepos } from "../core/ownership.js";
import { registerOwnedRepo, type RepoRegistrationEnv } from "../repo/owned.js";
import { ensureContextCommit } from "../repo/git.js";
import { JunctionError } from "./client.js";
import { repoIdentity, workspaceOf } from "./handoff.js";

export type ContinuationProgress = (stage: string, message: string) => void;

export function contextRepository(normalized: any) {
  const source = workspaceOf(normalized) || normalized.extensions?.["switchyard.capture/1"];
  const repoUrl = typeof source?.repo_url === "string" ? source.repo_url.trim() : "";
  return {
    repoUrl,
    commit: typeof source?.commit === "string" && /^[0-9a-f]{40,64}$/i.test(source.commit) ? source.commit : null,
    branch: typeof source?.branch === "string" && source.branch !== "HEAD" ? source.branch : null,
    dirty: source?.dirty,
  };
}

// Shared history may contain another machine's paths or Git remote helpers.
// Only network Git URLs can be registered automatically; authentication is local.
export function contextCloneUrl(value: string): string {
  if (!value || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new JunctionError(409, "Context 的仓库地址无效，请在来源设备修正仓库远程地址后重新共享。");
  }
  if (/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*:(?![/:])[^\s]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname || url.hostname.startsWith("-") || url.pathname === "/") throw new Error();
    // Do not import credentials from a historical context. SSH usernames are
    // part of the remote address, not a transferred authentication secret.
    if (url.protocol !== "ssh:") url.username = "";
    url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  } catch {
    throw new JunctionError(409, "此 Context 未记录可拉取的仓库地址，请在来源设备配置 Git 远程地址后重新共享。");
  }
}

/** Resolve on the executing device, including stale UI catalogs and SSH/HTTPS aliases. */
export async function prepareContextRepository(
  env: RepoRegistrationEnv,
  source: ReturnType<typeof contextRepository>,
  selectedId: number | undefined,
  progress: ContinuationProgress = () => {},
  signal?: AbortSignal,
): Promise<Repo> {
  signal?.throwIfAborted();
  let repo: Repo | undefined;
  if (selectedId !== undefined) {
    repo = getOwnedRepo(env.db, selectedId);
    if (!repo?.mirror_path || repo.status !== "ready") throw new JunctionError(409, "请选择当前设备已就绪的仓库。");
    if (source.repoUrl && repoIdentity(source.repoUrl) !== repoIdentity(repo.git_url)) {
      throw new JunctionError(409, "目标仓库与 Context 的来源仓库不一致。");
    }
  } else {
    if (!source.repoUrl) throw new JunctionError(409, "Context 未记录仓库地址，无法自动准备代码。");
    const sourceUrl = contextCloneUrl(source.repoUrl);
    const matches = listOwnedRepos(env.db).filter(r => repoIdentity(r.git_url) === repoIdentity(source.repoUrl));
    // Equivalent remotes can have multiple local registrations. Reuse the oldest
    // ready one consistently; every continuation still creates a fresh worktree.
    const ready = matches.filter(r => r.status === "ready" && r.mirror_path).sort((a, b) => a.id - b.id);
    repo = ready[0];
    if (!repo) {
      if (matches.some(r => r.status === "cloning")) throw new JunctionError(409, "对应仓库正在准备中，请稍后重试。");
      const previous = matches[0];
      const gitUrl = previous?.git_url || sourceUrl;
      const name = previous?.name || gitUrl.replace(/\/+$/, "").split(/[/:]/).at(-1)!.replace(/\.git$/i, "").slice(0, 100) || "repository";
      progress("repository", `正在添加仓库 ${name}…`);
      const result = await registerOwnedRepo(env, {
        name, git_url: gitUrl, token: previous?.token,
        default_branch: previous?.default_branch,
      }, signal);
      signal?.throwIfAborted();
      if (!result.ok) {
        const message = result.error === "timedOut" ? "连接仓库超过 30 秒，请检查当前设备的网络后重试。"
          : result.error === "notReady" ? "对应仓库正在准备中，请稍后重试。"
          : "无法添加仓库，请检查当前设备的 Git 访问权限和网络后重试。";
        const detail = result.message?.replace(/(https?:\/\/)[^\s/]+@/g, "$1[redacted]@").slice(-600);
        throw new JunctionError(409, message + (detail ? `\n${detail}` : ""));
      }
      repo = getOwnedRepo(env.db, result.id);
    } else progress("repository", `已匹配仓库 ${repo.name}。`);
  }
  if (!repo?.mirror_path) throw new JunctionError(409, "仓库尚未就绪，请重试。");
  signal?.throwIfAborted();
  if (source.commit) {
    progress("fetch", "正在准备 Context 对应的代码版本…");
    try { await ensureContextCommit(env.runner, repo.mirror_path, source.commit, signal); }
    catch (error: any) { throw new JunctionError(409, error.message); }
  }
  return repo;
}
