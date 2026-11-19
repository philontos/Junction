import os from "node:os";
import path from "node:path";
import type { Runner } from "../fleet/runner.js";
import { taskCwd, taskControlDir } from "../task/workspace.js";
import type { AgentAdapter, Entry, LaunchOpts } from "./types.js";
import { hasText, claudeAddDirArgs, toolArg, toolDetail, claudeContentStr, cap, OUT_CAP } from "./shared.js";

// Skip Claude's synthetic user turns: slash-command wrappers and injected caveats that
// aren't things the person typed. Real prompts and interruption notes pass through.
function isClaudeNoise(text: string): boolean {
  const s = text.trimStart();
  return s.startsWith("<command-") || s.startsWith("<local-command") || s.startsWith("Caveat:");
}

export function parseClaudeLine(o: any): Entry[] {
  if (!o || o.isSidechain) return [];   // drop sub-agent (Task tool) sidechains — noise in a read view
  const t = o.type;
  if (t !== "user" && t !== "assistant") return [];
  const c = o.message?.content;
  const out: Entry[] = [];
  if (typeof c === "string") {
    if (c.trim() && !(t === "user" && isClaudeNoise(c))) {
      out.push({ t: t === "user" ? "user" : "assistant", text: c });
    }
    return out;
  }
  if (!Array.isArray(c)) return out;
  for (const b of c) {
    if (b?.type === "text") {
      if (b.text?.trim() && !(t === "user" && isClaudeNoise(b.text))) out.push({ t: t === "user" ? "user" : "assistant", text: b.text });
    } else if (b?.type === "thinking") {
      if (b.thinking?.trim()) out.push({ t: "thinking", text: b.thinking });
    } else if (b?.type === "tool_use") {
      out.push({ t: "tool_call", id: String(b.id ?? ""), name: String(b.name ?? "tool"), arg: toolArg(b.input), detail: toolDetail(b.input) });
    } else if (b?.type === "tool_result") {
      out.push({ t: "tool_result", id: String(b.tool_use_id ?? ""), ok: !b.is_error, output: cap(claudeContentStr(b.content), OUT_CAP) });
    }
  }
  return out;
}

// https://code.claude.com/docs/en/agent-sdk/sessions#resume-by-id
const escapeClaudeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const claudeProjects = (home: string) => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects");
async function claudeFile(runner: Runner, home: string, cwd: string, sid: string): Promise<string | null> {
  const encoded = escapeClaudeCwd(cwd);
  const override = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  const name = override && !override.includes("/") && ![".", ".."].includes(override) ? override : encoded;
  const direct = path.join(claudeProjects(home), name, `${sid}.jsonl`);
  if (encoded.length <= 200 || override || await runner.exists(direct).catch(() => false)) return direct;
  // Long paths use a version-dependent hash suffix. Match the exact known
  // session ID in the documented prefix, never a "latest session" fallback.
  const found = (await runner.exec("find", [claudeProjects(home), "-maxdepth", "2", "-type", "f", "-name", `${sid}.jsonl`]).catch(() => ""))
    .trim().split("\n").filter(p => p && path.basename(path.dirname(p)).startsWith(encoded.slice(0, 200)));
  return found.length === 1 ? found[0] : null;
}


function launch(opts: LaunchOpts): string[] {
  // Claude's --add-dir is variadic (one flag followed by every directory),
  // unlike Codex/Kimi's repeatable single-dir option. `--` terminates that
  // variadic value before the positional opening prompt.
  const instructions = hasText(opts.workspaceInstructions)
    ? ["--append-system-prompt", opts.workspaceInstructions]
    : [];
  const dirs = claudeAddDirArgs(opts.addDirs);
  const settings = opts.claudeSettings ? ["--settings", opts.claudeSettings] : [];
  const identity = opts.sessionId ? ["--session-id", opts.sessionId] : [];
  if (opts.resume) return ["claude", ...(opts.sessionId ? ["--resume", opts.sessionId] : ["--continue"]), ...settings, ...instructions, ...dirs];
  if (!hasText(opts.prompt)) return ["claude", ...identity, ...settings, ...instructions, ...dirs];
  return dirs.length
    ? ["claude", ...identity, ...settings, ...instructions, ...dirs, "--", opts.prompt]
    : ["claude", ...identity, ...settings, ...instructions, opts.prompt];
}

export const claudeAdapter: AgentAdapter = {
  id: "claude", name: "Claude Code", version: 1, nativeFormat: "claude-code.jsonl",
  launch, parseLine: parseClaudeLine,
  async directoryResumeId(runner, task) {
    const observed = (await runner.readText(path.join(taskControlDir(runner.dataDir, task), ".claude", "session-id")))?.trim();
    return observed && /^[a-zA-Z0-9_-]{1,128}$/.test(observed) ? observed : task.claude_session;
  },
  async locate({ runner, task, archive }) {
    const observed = archive || task.kind === "directory"
      ? (await runner.readText(path.join(taskControlDir(runner.dataDir, task), ".claude", "session-id")).catch(() => null))?.trim() : null;
    const sid = observed && /^[a-zA-Z0-9_-]{1,128}$/.test(observed) ? observed : task.claude_session;
    if (!sid || !/^[a-zA-Z0-9_-]{1,128}$/.test(sid)) return null;
    const file = await claudeFile(runner, os.homedir(), taskCwd(task), sid);
    return file ? { file, source: `claude:${sid}` } : null;
  },
  imagePaste: { storageDir: path.join(".claude", "pasted"), gitExcludePattern: ".claude/pasted/", inputText: p => p },
};
