import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Runner } from "../fleet/runner.js";
import { taskCwd, taskMarker } from "../task/workspace.js";
import type { AgentAdapter, Entry, LaunchOpts } from "./types.js";
import { hasText, addDirArgs, toolArg, toolDetail, cap, oneLine, OUT_CAP, matchesTask, sh, ere } from "./shared.js";

export function parseCodexLine(o: any): Entry[] {
  // Only response_item lines carry the canonical transcript; event_msg mirrors them and
  // would double every message, so it's skipped.
  if (!o || o.type !== "response_item") return [];
  const p = o.payload ?? {};
  const pt = p.type;
  if (pt === "message") {
    const role = p.role;
    if (role !== "user" && role !== "assistant") return [];   // developer/system context → skip
    const text = (Array.isArray(p.content) ? p.content : []).filter((x: any) => /text/.test(x?.type)).map((x: any) => x.text ?? "").join("");
    if (!text.trim()) return [];
    if (role === "user" && text.trimStart().startsWith("<")) return [];   // <environment_context> etc.
    return [{ t: role, text }];
  }
  if (pt === "reasoning") {
    const text = (Array.isArray(p.summary) ? p.summary : []).map((s: any) => s?.text ?? "").join("\n");
    return text.trim() ? [{ t: "thinking", text }] : [];   // usually empty — Codex encrypts its reasoning
  }
  if (pt === "function_call" || pt === "custom_tool_call") {
    const input = pt === "function_call" ? p.arguments : p.input;
    return [{ t: "tool_call", id: String(p.call_id ?? p.id ?? ""), name: String(p.name ?? "tool"), arg: toolArg(input), detail: toolDetail(input) }];
  }
  if (pt === "function_call_output" || pt === "custom_tool_call_output") {
    return [{ t: "tool_result", id: String(p.call_id ?? ""), ok: true, output: cap(String(p.output ?? ""), OUT_CAP) }];
  }
  if (pt === "web_search_call") {
    return [{ t: "tool_call", id: String(p.id ?? ""), name: "web_search", arg: oneLine(JSON.stringify(p.action ?? {}), 140), detail: toolDetail(p.action) }];
  }
  return [];
}

// The event stream is the strongest source for identifying what the person
// actually submitted. Codex has emitted this semantic event in two shapes:
//
//   historical: event_msg(user_message).message
//   current:    event_msg(item_completed).item(UserMessage).content
//
// Unlike response_item(role=user), both exclude injected <environment_context>
// and other synthetic context. Keep this separate from parseCodexLine: the
// normal transcript uses response_item as its canonical all-role stream and
// would otherwise render every prompt twice.
export function parseCodexUserLine(o: any): Entry[] {
  if (!o || o.type !== "event_msg") return [];
  const payload = o.payload ?? {};
  let text = "";

  if (payload.type === "user_message") {
    text = typeof payload.message === "string" ? payload.message : "";
  } else if (payload.type === "item_completed" && payload.item?.type === "UserMessage") {
    const content = payload.item.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.map((part: any) => {
        if (typeof part === "string") return part;
        if ((part?.type === "text" || part?.type === "input_text") && typeof part.text === "string") {
          return part.text;
        }
        return "";
      }).join("");
    }
  }

  return text.trim() ? [{ t: "user", text }] : [];
}

const codexPathCache = new Map<number, string>();
async function locateCodex(
  runner: Runner,
  home: string,
  cwd: string,
  taskId: number,
  refresh = false,
  marker?: string,
): Promise<string | null> {
  const cached = codexPathCache.get(taskId);
  if (!refresh && cached && (await runner.exists(cached).catch(() => false))) return cached;
  const dir = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  const needle = `"cwd"[[:space:]]*:[[:space:]]*${ere(JSON.stringify(cwd))}`;
  // newest-first (the ISO date lives in the path), stop at the first rollout whose
  // session_meta line names this worktree. Use an ERE instead of a literal
  // `"cwd":"..."` substring because Codex JSONL formatting can include spaces after
  // colons; missing that file leaves mobile stuck in the live xterm instead of the
  // native-scrolling reading view.
  const cmd = `find ${sh(dir)} -name 'rollout-*.jsonl' 2>/dev/null | sort -r | while IFS= read -r f; do `
    + `head -c 4096 "$f" | grep -Eq ${sh(needle)} && { printf '%s\\n' "$f"; ${marker ? "" : "break;"} }; done`;
  const candidates = (await runner.exec("sh", ["-c", cmd]).catch(() => "")).trim().split("\n").filter(Boolean);
  let found: string | undefined;
  for (const candidate of candidates) {
    if (!marker || await matchesTask(runner, candidate, marker)) { found = candidate; break; }
  }
  if (found) codexPathCache.set(taskId, found);
  return found || null;
}


function launch(opts: LaunchOpts): string[] {
    const instructions = hasText(opts.workspaceInstructions)
      ? ["-c", `developer_instructions=${JSON.stringify(opts.workspaceInstructions)}`]
      : [];
    const base = [
      "codex", "-a", "on-request", "-s", "danger-full-access",
      ...instructions,
      ...addDirArgs(opts.addDirs),
    ];
    if (hasText(opts.model)) base.push("-m", opts.model.trim());
    if (opts.resume) return [...base, "resume", opts.sessionId || "--last"];
    const argv = [...base];
    if (hasText(opts.prompt)) argv.push(opts.prompt);
    return argv;
}

export const codexAdapter: AgentAdapter = {
  id: "codex", name: "Codex", version: 1, nativeFormat: "codex-rollout.jsonl", writableGitDirs: true,
  launch, parseLine: parseCodexLine, parseUserLine: parseCodexUserLine, userOnlyMode: "codex-user-message-v1",
  async locate({ runner, task, refresh, archive }) {
    const file = await locateCodex(runner, os.homedir(), taskCwd(task), task.id, refresh || archive, task.kind === "directory" ? taskMarker(task) : undefined);
    return file ? { file, source: `codex:${path.basename(file)}` } : null;
  },
  async directoryResumeId(runner, task) {
    const located = await codexAdapter.locate({ runner, task, refresh: true });
    if (!located) return null;
    const handle = await fs.open(located.file, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const meta = JSON.parse(buffer.subarray(0, bytesRead).toString().split("\n")[0]);
      return meta.payload?.id || meta.payload?.session_id || null;
    } finally { await handle.close(); }
  },
  imagePaste: { storageDir: path.join(".codex", "pasted"), gitExcludePattern: ".codex/pasted/", inputText: p => `Use this image as visual context: ${p}` },
};
