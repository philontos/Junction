import type { CommandRunner } from "../fleet/runner.js";
import { agentAdapter, type AgentKind, type LaunchOpts } from "../agents/index.js";

async function tmux(runner: CommandRunner, args: string[]): Promise<string> {
  return runner.exec("tmux", args);
}

function absGitPath(cwd: string, p: string): string {
  const s = p.trim();
  if (!s || s.startsWith("/")) return s;
  return `${cwd.replace(/\/+$/, "")}/${s.replace(/^\.\//, "")}`;
}

async function gitPath(runner: CommandRunner, cwd: string, flag: "--git-dir" | "--git-common-dir"): Promise<string | null> {
  try {
    return (await runner.exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", flag])).trim();
  } catch {
    try {
      const p = (await runner.exec("git", ["-C", cwd, "rev-parse", flag])).trim();
      return absGitPath(cwd, p);
    } catch {
      return null;
    }
  }
}

async function extraWritableGitDirs(runner: CommandRunner, cwd: string, agent: AgentKind): Promise<string[]> {
  if (!agentAdapter(agent).writableGitDirs) return [];
  const dirs = await Promise.all([
    gitPath(runner, cwd, "--git-dir"),
    gitPath(runner, cwd, "--git-common-dir"),
  ]);
  return [...new Set(dirs.filter((d): d is string => !!d))];
}

async function sessionAddDirs(
  runner: CommandRunner,
  cwd: string,
  agent: AgentKind,
  additionalRoots: string[] = [],
): Promise<string[]> {
  const roots = [...new Set(additionalRoots.map((dir) => dir.trim()).filter(Boolean))];
  // Codex/Kimi sandbox roots must also cover the linked worktree's per-worktree
  // gitdir and shared bare mirror. Claude already follows Git metadata from each
  // --add-dir root using its own permission model.
  const metadata = agentAdapter(agent).writableGitDirs
    ? (await Promise.all([cwd, ...roots].map((root) => extraWritableGitDirs(runner, root, agent)))).flat()
    : [];
  return [...new Set([...roots, ...metadata])];
}

/**
 * Build an `env K=V ...` prefix that sets per-session vars directly on the
 * launched process. `tmux new-session` does NOT propagate arbitrary env vars
 * into a new session (only its `update-environment` allowlist), so we can't
 * count on the spawn's own environment reaching claude — we prepend an `env`
 * command that sets them on the claude process itself. Used to point claude at
 * an alternate model backend (ANTHROPIC_BASE_URL / _AUTH_TOKEN / _MODEL …).
 * Agent tools can leave NO_COLOR=1 in a long-lived tmux server's environment.
 * These are interactive terminals: remove that inherited flag at the process
 * boundary, while still allowing an explicit per-task env override. Cleaning
 * only the node process would not clean tmux's saved environment.
 * Empty values are dropped; each `K=V` is one argv element, so values with
 * spaces need no shell quoting here.
 */
function envPrefix(env?: Record<string, string>): string[] {
  const pairs = Object.entries(env ?? {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return ["env", "-u", "NO_COLOR", ...pairs];
}

function requireOwnerNode(runner: CommandRunner): void {
  if (runner.kind !== "local") throw new Error("Sessions must be created by the node that owns them");
}

/**
 * Start a detached tmux session running the agent (claude by default, or codex/kimi)
 * in the worktree. If a prompt is given it is passed as the agent's initial
 * message; the session stays interactive (TUI). opts.env injects environment for
 * the process (claude's alternate provider). opts.model picks a codex/kimi model.
 * How to launch/resume each agent lives in agentArgv — this stays agent-agnostic.
 */
export async function startSession(
  runner: CommandRunner & { dataDir?: string },
  session: string,
  cwd: string,
  prompt?: string | null,
  opts?: {
    continue?: boolean;
    env?: Record<string, string>;
    agent?: AgentKind;
    model?: string | null;
    addDirs?: string[];
    workspaceInstructions?: string | null;
    kimiAgentFile?: string | null;
    sessionId?: string;
    claudeSettings?: string;
    binary?: string;
  },
) {
  requireOwnerNode(runner);
  // resume reattaches to the prior conversation (agents key it by cwd). The
  // original opening prompt is NOT re-sent — the conversation already has it.
  // The env prefix (provider) goes BEFORE the agent argv so the vars land on the
  // agent process.
  const agent = opts?.agent ?? "claude";
  const adapter = agentAdapter(agent);
  const pre = envPrefix(opts?.env);
  const launchOpts: LaunchOpts = {
    ...opts, prompt, resume: opts?.continue,
    addDirs: await sessionAddDirs(runner, cwd, agent, opts?.addDirs),
  };
  const prepared = await adapter.prepareLaunch?.({ runner, session, cwd, opts: launchOpts });
  const finalOpts = { ...launchOpts, ...prepared };
  const launch = adapter.launch(finalOpts);
  if (finalOpts.binary) launch[0] = finalOpts.binary;
  const cmd = ["new-session", "-d", "-s", session, "-c", cwd, ...pre, ...launch];
  await tmux(runner, cmd);
  await ensureSessionOptions(runner, session);
  if (adapter.initialPrompt === "afterReady" && !opts?.continue && prompt?.trim()) {
    // tmux reports a detached session before Kimi has switched the pane into TUI
    // input mode. Text sent in that window is merely echoed by the terminal and
    // never reaches Kimi, so wait for its first complete render before pasting.
    await adapter.waitUntilReady?.(runner, session);
    await pasteSubmit(runner, session, prompt);
  }
}

/**
 * Start a detached bare-shell tmux session (the login shell, no command) in cwd.
 * Used by the local quick task: a throwaway terminal where the user cd's and
 * runs claude (or anything) themselves — deliberately more general than
 * auto-launching claude.
 */
export async function startShellSession(runner: CommandRunner, session: string, cwd: string) {
  requireOwnerNode(runner);
  await tmux(runner, ["new-session", "-d", "-s", session, "-c", cwd]);
  await ensureSessionOptions(runner, session);
}

/**
 * Normalize the tmux options Switchyard relies on for its web terminal. User/global
 * tmux config differs across machines; in particular `mouse off` makes trackpad
 * wheel gestures fall through as Up/Down keys in Codex, which flips prompt history
 * instead of scrolling.
 *
 * `window-size latest`: a tmux window has ONE width shared by every attached
 * client, so two differently-sized viewers can't both be full-width at the same
 * moment — the choice is only whose width wins. `latest` hands the window to the
 * most recently ACTIVE client: whichever device you're actually typing on fills
 * its own screen (the 14" relay gets 146, the 16" browser gets 173). The costs,
 * accepted deliberately: a TUI redraws (SIGWINCH) when the width flips between
 * active clients of different sizes, and an inactive client shows tmux's dot
 * padding (client wider than the window) or a clipped viewport (client narrower)
 * until its next keystroke. (`smallest` avoids the redraw churn but leaves the
 * bigger screen permanently dot-padded whenever a small client stays attached —
 * that read as "the right side is broken", which is worse.)
 *
 * Set these on every dispatcher-owned session and again when attaching an older
 * session. Each command stays best-effort for older tmux versions.
 */
export async function ensureSessionOptions(runner: CommandRunner, session: string) {
  // keep the pane around if the agent/shell exits so the user can read the result
  await tmux(runner, ["set-option", "-t", session, "remain-on-exit", "on"]).catch(() => {});
  await tmux(runner, ["set-option", "-t", session, "mouse", "on"]).catch(() => {});
  await tmux(runner, ["set-window-option", "-t", session, "window-size", "latest"]).catch(() => {});
}

export async function hasSession(runner: CommandRunner, session: string): Promise<boolean> {
  if (!session || !session.trim()) return false;
  try {
    // "=" forces exact match — otherwise tmux prefix-matches and "tdsp-1" would be
    // reported live whenever "tdsp-12" exists (a wrong green/alive light).
    await tmux(runner, ["has-session", "-t", "=" + session]);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(runner: CommandRunner, session: string) {
  // An empty target makes tmux kill the CURRENT/most-recent session — so a task
  // whose session was never set (a failed dispatch stores "") would, on cleanup,
  // tear down whatever session you're actively using. Never let "" reach tmux.
  if (!session || !session.trim()) return;
  // "=" forces an exact-match target; without it tmux prefix-matches, so killing
  // "tdsp-1" could also catch "tdsp-12".
  await tmux(runner, ["kill-session", "-t", "=" + session]).catch(() => {});
}

/**
 * Force the session's active pane out of copy/scroll mode so a client attaching
 * next lands on the live prompt instead of stale scrollback. `-X cancel` is a
 * copy-mode COMMAND, not a keystroke: in copy-mode it exits, and when the pane
 * is NOT in a mode tmux just errors and inserts nothing — unlike a literal `q`,
 * which would be typed into claude's prompt. Best-effort, so errors are ignored.
 */
export async function cancelCopyMode(runner: CommandRunner, session: string) {
  await tmux(runner, ["send-keys", "-t", session, "-X", "cancel"]).catch(() => {});
}

/**
 * Inject text into a session's input as a BRACKETED PASTE (not keystrokes). A
 * named buffer keeps the user's paste buffers untouched; -d removes it after.
 * No trailing newline, so it never auto-submits — the user adds text and Enters.
 */
export async function pasteText(runner: CommandRunner, session: string, text: string) {
  await tmux(runner, ["set-buffer", "-b", "tdsp-paste", "--", text]);
  await tmux(runner, ["paste-buffer", "-t", session, "-b", "tdsp-paste", "-p", "-d"]);
}

/**
 * Mobile quick-input submits a complete message to the real tmux pane, not to
 * the browser's attach client. Pasting handles arbitrary Unicode/newlines as one
 * input; send-keys Enter then submits it as a real terminal Enter.
 */
export async function pasteSubmit(runner: CommandRunner, session: string, text: string) {
  if (text) await pasteText(runner, session, text);
  await tmux(runner, ["send-keys", "-t", session, "Enter"]);
}

/** List all dispatcher-owned tmux sessions (named task-<id>). */
export async function listSessions(runner: CommandRunner): Promise<string[]> {
  try {
    const out = await tmux(runner, ["list-sessions", "-F", "#{session_name}"]);
    return out.split("\n").map((s) => s.trim()).filter((s) => /^(tdsp|task)-([a-z0-9]+-)?\d+(-[a-z0-9-]+)?$/.test(s));
  } catch {
    return []; // no server / no sessions
  }
}
