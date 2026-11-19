// Read a task's agent conversation as a normalized, append-only entry stream — the
// data behind the mobile "阅读 / Reading" view. The supported transcript parsers persist their
// session to disk as JSONL; we locate that file, tail it from a byte cursor, and map
// each line to agent-agnostic Entry objects the client renders as a chat.
//
//   Claude:  ~/.claude/projects/<escaped-cwd>/<session>.jsonl   (session id captured
//            by the SessionStart hook → tasks.claude_session; cwd = the worktree)
//   Codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl  (no hook, so we
//            locate it the way `codex resume --last` does: newest rollout whose
//            session_meta.cwd == the worktree)
//   Kimi:    ~/.kimi-code/session_index.jsonl maps the worktree to a session dir;
//            agents/main/wire.jsonl is its durable conversation event stream.
//
// All file access is performed by the task's owning node. A controller asks that
// node for higher-level task operations; it never locates or tails the node's
// transcript files over SSH. Parsing is stateless per line, so tailing remains a
// pure append with a simple byte cursor.
import type { Runner } from "../fleet/runner.js";
import { agentAdapter, asAgentKind, type AgentKind } from "../agents/index.js";
import { isAgentKind } from "./agent.js";
import type { Task } from "../core/db.js";
import { taskCwd } from "../task/workspace.js";

import type { Entry } from "../agents/types.js";
export type { Entry } from "../agents/types.js";
export { parseClaudeLine } from "../agents/claude.js";
export { parseCodexLine, parseCodexUserLine } from "../agents/codex.js";
export { parseKimiLine, locateDirectoryKimi } from "../agents/kimi.js";
export { parsePiLine } from "../agents/pi.js";
export { hasTaskBinding } from "../agents/shared.js";

/** Native bytes are archived separately from the truncated reading view. */
export async function locateNativeJsonl(runner: Runner, task: Task): Promise<string | null> {
  if (runner.kind !== "local" || !taskCwd(task) || task.kind === "local") return null;
  const adapter = agentAdapter(asAgentKind(task.agent));
  if (!adapter.nativeFormat) return null;
  return (await adapter.locate({ runner, task, archive: true }))?.file || null;
}

export interface TranscriptResult {
  agent: AgentKind;
  /** Opaque identity of the underlying session. It deliberately contains no
   *  owner-local path; when it changes, the client drops its cursor. */
  source: string | null;
  entries: Entry[];
  /** byte offset to pass back as `since` on the next poll to get only what's new. */
  cursor: number;
  /** More complete lines are ready. The client may fetch the next page immediately. */
  hasMore?: boolean;
  /** Proof that Codex entries came from semantic user_message events. */
  mode?: "codex-user-message-v1";
}

export const TRANSCRIPT_CAPABILITY = "transcript-v1";
export interface TranscriptReadRequest {
  taskId: number;
  since: number;
  source: string | null;
  userOnly?: boolean;
}
export type TranscriptCommandResult =
  | { ok: true; transcript: TranscriptResult }
  | { ok: false; error: "notFound" | "invalidRequest" | "readFailed"; message: string };

const SOURCE_CAP = 4096;
const PAGE_CAP = 4 * 1024 * 1024;
export function isTranscriptReadRequest(value: unknown): value is TranscriptReadRequest {
  const request = value as Partial<TranscriptReadRequest> | null;
  return !!request
    && Number.isSafeInteger(request.taskId) && Number(request.taskId) > 0
    && Number.isSafeInteger(request.since) && Number(request.since) >= 0
    && (request.source === null || (typeof request.source === "string" && request.source.length <= SOURCE_CAP))
    && (request.userOnly === undefined || typeof request.userOnly === "boolean");
}

function isEntry(value: unknown): value is Entry {
  const entry = value as Record<string, unknown> | null;
  if (!entry || typeof entry.t !== "string") return false;
  if (entry.t === "user" || entry.t === "assistant" || entry.t === "thinking") {
    return typeof entry.text === "string";
  }
  if (entry.t === "tool_call") {
    return typeof entry.id === "string"
      && typeof entry.name === "string"
      && typeof entry.arg === "string"
      && typeof entry.detail === "string";
  }
  if (entry.t === "tool_result") {
    return typeof entry.id === "string"
      && typeof entry.ok === "boolean"
      && typeof entry.output === "string";
  }
  return false;
}

export function isTranscriptResult(value: unknown): value is TranscriptResult {
  const result = value as Partial<TranscriptResult> | null;
  return !!result
    && isAgentKind(result.agent)
    && (result.source === null || (typeof result.source === "string" && result.source.length <= SOURCE_CAP))
    && Number.isSafeInteger(result.cursor) && Number(result.cursor) >= 0
    && Array.isArray(result.entries) && result.entries.every(isEntry)
    && (result.hasMore === undefined || typeof result.hasMore === "boolean")
    && (result.mode === undefined || result.mode === "codex-user-message-v1");
}

// ---- tail ----

// Read a file's bytes from `since` to EOF, keeping only complete lines. Returns the new
// text and the advanced byte cursor; resets to 0 if the file shrank (rotated).
async function tailFrom(runner: Runner, file: string, since: number): Promise<{ text: string; cursor: number } | null> {
  const sizeOut = await runner.exec("wc", ["-c", file]).catch(() => null);
  if (sizeOut == null) return null;   // missing / unreadable
  const size = parseInt(sizeOut.trim().split(/\s+/)[0] || "0", 10) || 0;
  let from = since > size ? 0 : since;   // shrank/rotated → reload from the top
  if (from >= size) return { text: "", cursor: size };
  const raw = await runner.exec("tail", ["-c", "+" + (from + 1), file]).catch(() => "");
  const lastNl = raw.lastIndexOf("\n");
  if (lastNl < 0) return { text: "", cursor: from };   // no complete line yet
  const consumed = raw.slice(0, lastNl + 1);
  return { text: consumed, cursor: from + Buffer.byteLength(consumed, "utf8") };
}

/**
 * Read a task's conversation incrementally. `since` is the byte cursor from the previous
 * call (0 / omitted for a fresh load); `knownSource` is the client's last source id — if
 * it no longer matches (a new session / rollout), we reload from the top so the client
 * doesn't stitch two conversations together.
 */
export async function readTranscript(
  runner: Runner,
  task: Task,
  since = 0,
  knownSource: string | null = null,
  options: { userOnly?: boolean } = {},
): Promise<TranscriptResult> {
  if (runner.kind !== "local") throw new Error("Transcript must be read by the node that owns the task");
  const agent = asAgentKind(task.agent);
  const adapter = agentAdapter(agent);
  const userOnly = !!adapter.parseUserLine && options.userOnly === true;
  const mode = userOnly ? adapter.userOnlyMode : undefined;
  const cwd = task.kind === "local" ? "" : taskCwd(task);
  if (!cwd) return { agent, source: null, entries: [], cursor: 0, hasMore: false, mode };
  const located = await adapter.locate({ runner, task, refresh: userOnly });
  const file = located?.file, source = located?.source;
  if (!file || !source) return { agent, source: null, entries: [], cursor: 0, hasMore: false, mode };

  const from = knownSource && knownSource !== source ? 0 : since;   // source changed → reload
  const tail = await tailFrom(runner, file, from);
  if (!tail) return { agent, source, entries: [], cursor: from, hasMore: false, mode };

  const parse = userOnly ? adapter.parseUserLine! : adapter.parseLine;
  const entries: Entry[] = [];
  let cursor = from;
  let payloadBytes = 0;
  for (const line of tail.text.split("\n")) {
    if (!line) {
      if (cursor < tail.cursor) cursor += 1;
      continue;
    }
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    let o: any;
    try { o = JSON.parse(line); } catch {
      cursor += lineBytes;
      continue;
    }
    const next = parse(o);
    const nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
    if (entries.length && payloadBytes + nextBytes > PAGE_CAP) break;
    entries.push(...next);
    payloadBytes += nextBytes;
    cursor += lineBytes;
  }
  cursor = Math.min(cursor, tail.cursor);
  return { agent, source, entries, cursor, hasMore: cursor < tail.cursor, mode };
}
