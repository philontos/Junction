import os from "node:os";
import path from "node:path";
import type { Runner } from "../fleet/runner.js";
import type { Task } from "../core/db.js";
import { taskCwd, taskMarker } from "../task/workspace.js";
import type { AgentAdapter, Entry, LaunchOpts } from "./types.js";
import { hasText, addDirArgs, toolArg, toolDetail, kimiContentStr, cap, OUT_CAP, matchesTask } from "./shared.js";
import type { CommandRunner } from "../fleet/runner.js";

export function parseKimiLine(o: any): Entry[] {
  if (!o || typeof o !== "object") return [];

  // turn.prompt/turn.steer are followed by this canonical context message, so
  // parsing both would duplicate every user turn. Injections (permission mode,
  // todo reminders, compaction summaries, etc.) are agent context, not things
  // the person typed, and stay out of the reading view.
  if (o.type === "context.append_message") {
    const m = o.message ?? {};
    if (m.role !== "user" || m.origin?.kind !== "user") return [];
    const text = kimiContentStr(m.content);
    return text.trim() ? [{ t: "user", text }] : [];
  }

  if (o.type !== "context.append_loop_event") return [];
  const e = o.event ?? {};
  if (e.type === "content.part") {
    const p = e.part ?? {};
    if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
      return [{ t: "assistant", text: p.text }];
    }
    if ((p.type === "think" || p.type === "thinking")) {
      const text = typeof p.think === "string" ? p.think : typeof p.thinking === "string" ? p.thinking : "";
      return text.trim() ? [{ t: "thinking", text }] : [];
    }
    return [];
  }
  if (e.type === "tool.call") {
    return [{
      t: "tool_call",
      id: String(e.toolCallId ?? e.id ?? ""),
      name: String(e.name ?? "tool"),
      arg: toolArg(e.args),
      detail: toolDetail(e.args),
    }];
  }
  if (e.type === "tool.result") {
    const result = e.result ?? {};
    const output = result.output ?? result.content ?? "";
    return [{
      t: "tool_result",
      id: String(e.toolCallId ?? e.id ?? ""),
      ok: !result.isError,
      output: cap(kimiContentStr(output), OUT_CAP),
    }];
  }
  return [];
}

interface KimiSessionIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
  order: number;
}

// Kimi's index is append-only: a later record replaces/deletes an earlier record
// with the same session id. A worktree can have multiple sessions after /new or
// /sessions, so prefer the state.json with the newest activity timestamp, using
// index order as a deterministic fallback. Re-evaluating the small index on each
// poll lets Read follow a session switch and causes the source id to reset cleanly.
async function locateKimi(runner: Runner, home: string, cwd: string, marker?: string): Promise<{ file: string; source: string } | null> {
  const kimiHome = process.env.KIMI_CODE_HOME || path.join(home, ".kimi-code");
  const sessionsRoot = path.resolve(kimiHome, "sessions");
  const raw = await runner.readText(path.join(kimiHome, "session_index.jsonl")).catch(() => null);
  if (!raw) return null;

  const byId = new Map<string, KimiSessionIndexEntry>();
  let order = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec.sessionId !== "string") continue;
    if (rec.deleted === true) { byId.delete(rec.sessionId); continue; }
    if (typeof rec.sessionDir !== "string" || typeof rec.workDir !== "string") continue;
    byId.set(rec.sessionId, { ...rec, order: order++ });
  }

  let best: { file: string; activity: number; order: number } | null = null;
  for (const rec of byId.values()) {
    if (path.resolve(rec.workDir) !== path.resolve(cwd)) continue;
    const sessionDir = path.resolve(rec.sessionDir);
    const rel = path.relative(sessionsRoot, sessionDir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || path.basename(sessionDir) !== rec.sessionId) continue;
    const file = path.join(sessionDir, "agents", "main", "wire.jsonl");
    if (!(await runner.exists(file).catch(() => false))) continue;
    if (marker && !(await matchesTask(runner, file, marker))) continue;

    let activity = 0;
    const state = await runner.readText(path.join(sessionDir, "state.json")).catch(() => null);
    if (state) {
      try {
        const parsed = JSON.parse(state);
        const recordedCwd = typeof parsed?.workDir === "string" ? path.resolve(parsed.workDir) : null;
        if (recordedCwd && recordedCwd !== path.resolve(cwd)) continue;
        activity = Date.parse(parsed?.updatedAt || parsed?.createdAt || "") || 0;
      } catch {}
    }
    if (!best || activity > best.activity || (activity === best.activity && rec.order > best.order)) {
      best = { file, activity, order: rec.order };
    }
  }
  if (!best) return null;
  const sessionId = path.basename(path.dirname(path.dirname(path.dirname(best.file))));
  return { file: best.file, source: `kimi:${sessionId}` };
}
export function locateDirectoryKimi(runner: Runner, task: Task) {
  return locateKimi(runner, os.homedir(), taskCwd(task), taskMarker(task));
}
const KIMI_READY_TEXT = "Welcome to Kimi Code!";
const KIMI_READY_POLL_MS = 100;
const KIMI_READY_ATTEMPTS = 100;

async function kimiBinary(runner: CommandRunner): Promise<string> {
  const script = "command -v kimi 2>/dev/null || { p=\"$HOME/.kimi-code/bin/kimi\"; [ -x \"$p\" ] && printf '%s\\n' \"$p\"; }";
  const out = (await runner.exec("sh", ["-c", script]).catch(() => "")).trim();
  return out.split("\n").find(Boolean) || "kimi";
}

async function waitForKimiReady(runner: CommandRunner, session: string): Promise<void> {
  for (let attempt = 0; attempt < KIMI_READY_ATTEMPTS; attempt++) {
    // Include scrollback: on a short pane the welcome card can move above the
    // visible screen once startup notices and the editor have rendered.
    const pane = await runner.exec("tmux", ["capture-pane", "-p", "-t", session, "-S", "-100"]);
    if (pane.includes(KIMI_READY_TEXT)) return;
    if (attempt + 1 < KIMI_READY_ATTEMPTS) {
      await new Promise<void>((resolve) => setTimeout(resolve, KIMI_READY_POLL_MS));
    }
  }
  // A future Kimi release may change the welcome copy. After the bounded wait,
  // still submit so a cosmetic change does not permanently drop every opening.
}


function launch(opts: LaunchOpts): string[] {
    const boundAgent = !opts.resume && hasText(opts.kimiAgentFile)
      ? ["--agent-file", opts.kimiAgentFile.trim()]
      : [];
    const base = ["kimi", "--auto", ...boundAgent, ...addDirArgs(opts.addDirs)];
    if (hasText(opts.model)) base.push("-m", opts.model.trim());
    if (opts.resume) return [...base, ...(opts.sessionId ? ["--session", opts.sessionId] : ["--continue"])];
    const argv = [...base];
    return argv;
}

export const kimiAdapter: AgentAdapter = {
  id: "kimi", name: "Kimi Code", version: 1, nativeFormat: null, writableGitDirs: true,
  launch, parseLine: parseKimiLine, initialPrompt: "afterReady", waitUntilReady: waitForKimiReady,
  async prepareLaunch({ runner, opts }) { return { binary: opts.binary || await kimiBinary(runner) }; },
  async locate({ runner, task }) {
    return locateKimi(runner, os.homedir(), taskCwd(task), task.kind === "directory" ? taskMarker(task) : undefined);
  },
  async directoryResumeId(runner, task) {
    return (await locateDirectoryKimi(runner, task))?.source.replace(/^kimi:/, "") || null;
  },
  imagePaste: { storageDir: path.join(".kimi-code", "pasted"), gitExcludePattern: ".kimi-code/pasted/", inputText: p => `Use this image as visual context: ${p}` },
};
