import type { CommandRunner } from "../fleet/runner.js";

/** A process observation, separate from the task's persisted lifecycle status. */
export interface SessionRuntime {
  state: "running" | "exited" | "missing" | "unknown";
  exitCode?: number;
  signal?: string;
}

interface Pane {
  id: string;
  dead: boolean;
  exitCode?: number;
  signal?: string;
}

// launchd often has no UTF-8 locale. tmux then renders literal tabs as `_`;
// a printable ASCII separator works in both interactive and daemon environments.
const FORMAT = "#{session_name}|#{pane_id}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}";

/** One bounded query covers every task. A retained terminal is not a live agent. */
export async function readSessionRuntimes(runner: CommandRunner) {
  const sessions = new Map<string, Pane[]>();
  let fallback: SessionRuntime["state"] = "missing";
  try {
    const output = await runner.exec("tmux", ["list-panes", "-a", "-F", FORMAT], { timeoutMs: 3000 });
    for (const line of output.split("\n").filter(Boolean)) {
      const fields = line.split("|");
      const signal = fields.pop(), code = fields.pop(), dead = fields.pop(), id = fields.pop();
      const session = fields.join("|"); // tolerate delimiters in unrelated session names
      if (!session || !/^%\d+$/.test(id || "") || !/^[01]$/.test(dead || "")) {
        throw new Error("Invalid tmux pane observation");
      }
      const pane: Pane = {
        id: id!, dead: dead === "1",
        ...(dead === "1" && /^\d+$/.test(code || "") ? { exitCode: Number(code) } : {}),
        ...(dead === "1" && signal && signal !== "0" ? { signal } : {}),
      };
      sessions.set(session, [...(sessions.get(session) || []), pane]);
    }
  } catch (error: any) {
    sessions.clear();
    // No tmux server is normal after a reboot. Permissions/timeouts are unknown,
    // never evidence that all agents exited or permission to restart them.
    const message = String(error?.stderr || error?.message || error);
    fallback = /no server running|no sessions|error connecting to .*\(No such file or directory\)/i.test(message)
      ? "missing" : "unknown";
  }
  return {
    get(session: string): SessionRuntime {
      if (!session?.trim()) return { state: "missing" };
      const panes = sessions.get(session); // exact identity; no tmux prefix match
      if (!panes) return { state: fallback };
      if (panes.some(pane => !pane.dead)) return { state: "running" };
      const pane = panes.length === 1 ? panes[0] : undefined;
      return { state: "exited", ...(pane?.exitCode !== undefined ? { exitCode: pane.exitCode } : {}),
        ...(pane?.signal ? { signal: pane.signal } : {}) };
    },
    exitedPane(session: string): string | null {
      const panes = sessions.get(session);
      // Junction owns one pane per task. Never guess which pane to replace in a
      // manually modified, multi-pane session.
      return panes?.length === 1 && panes[0].dead ? panes[0].id : null;
    },
  };
}
