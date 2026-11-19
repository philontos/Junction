import fs from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, Entry, LaunchOpts } from "./types.js";
import { taskCwd } from "../task/workspace.js";
import { hasText, cap, claudeContentStr, toolArg, toolDetail, OUT_CAP } from "./shared.js";

// Keep native files written by Pi itself, scoped to a Switchyard task. Two
// tasks in the same cwd must never fall back to each other's latest session.
export const piSessionDir = (dataDir: string, session: string) =>
  path.join(dataDir, "agent-sessions", "pi", encodeURIComponent(session));

export async function locatePiSession(dataDir: string, session: string, cwd: string): Promise<string | null> {
  const dir = piSessionDir(dataDir, session);
  // Pi resolves symlinked working directories (e.g. macOS /var → /private/var).
  const canonicalCwd = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(async e => {
    const file = path.join(dir, e.name);
    let handle;
    try {
      handle = await fs.open(file, "r");
      const stat = await handle.stat();
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const header = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]);
      if (header.type !== "session" || typeof header.cwd !== "string") return null;
      const recordedCwd = await fs.realpath(header.cwd).catch(() => path.resolve(header.cwd));
      if (recordedCwd !== canonicalCwd) return null;
      return { file, mtime: stat.mtimeMs };
    } catch { return null; }
    finally { await handle?.close(); }
  }));
  return files.filter(f => f !== null).sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file))[0]?.file ?? null;
}

export function parsePiLine(o: any): Entry[] {
  if (o?.type === "compaction" || o?.type === "branch_summary") {
    return typeof o.summary === "string" ? [{ t: "assistant", text: `[${o.type === "compaction" ? "Context 压缩摘要" : "分支摘要"}]\n${o.summary}` }] : [];
  }
  if (o?.type !== "message" || !o.message || typeof o.message !== "object") return [];
  const message = o.message;
  if (message.role === "toolResult") return [{ t: "tool_result", id: String(message.toolCallId ?? ""), ok: !message.isError, output: cap(claudeContentStr(message.content), OUT_CAP) }];
  if (!["user", "assistant"].includes(message.role)) return [];
  const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (!Array.isArray(blocks)) return [];
  const out: Entry[] = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) out.push({ t: message.role, text: block.text });
    else if (block?.type === "thinking" && typeof block.thinking === "string") out.push({ t: "thinking", text: block.thinking });
    else if (block?.type === "toolCall") out.push({ t: "tool_call", id: String(block.id ?? ""), name: String(block.name ?? "tool"), arg: toolArg(block.arguments), detail: toolDetail(block.arguments) });
    else if (block?.type === "image") out.push({ t: message.role, text: "[image]" });
  }
  return out;
}


function launch(opts: LaunchOpts): string[] {
    const base = ["pi"];
    if (hasText(opts.sessionDir)) base.push("--session-dir", opts.sessionDir);
    if (hasText(opts.workspaceInstructions)) base.push("--append-system-prompt", opts.workspaceInstructions);
    if (hasText(opts.model)) base.push("--model", opts.model.trim());
    if (opts.resume) return [...base, ...(opts.sessionFile ? ["--session", opts.sessionFile] : ["--continue"])];
    return hasText(opts.prompt) ? [...base, "--", opts.prompt] : base;
}

export const piAdapter: AgentAdapter = {
  id: "pi", name: "Pi", version: 1, nativeFormat: "pi-session.jsonl",
  installCommand: "npm install -g @earendil-works/pi-coding-agent",
  launch, parseLine: parsePiLine,
  async prepareLaunch({ runner, session, cwd, opts }) {
    if (!runner.dataDir) throw new Error("Pi session storage requires the owning node's data directory.");
    const binary = opts.binary || (await runner.exec("sh", ["-c", 'command -v "$1"', "sh", "pi"]).catch(() => "")).trim();
    if (!path.isAbsolute(binary)) throw new Error("本机未找到 Pi，请先安装：npm install -g @earendil-works/pi-coding-agent，然后在本机运行 pi 完成认证。");
    const sessionDir = piSessionDir(runner.dataDir, session);
    const sessionFile = opts.resume ? await locatePiSession(runner.dataDir, session, cwd) : undefined;
    if (opts.resume && !sessionFile) throw new Error("未找到此任务的 Pi 会话，无法安全恢复。请新建任务或从共享 Context 接续。");
    await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    return { binary, sessionDir, sessionFile: sessionFile || undefined };
  },
  async locate({ runner, task }) {
    const file = await locatePiSession(runner.dataDir, task.session, taskCwd(task));
    return file ? { file, source: `pi:${path.basename(file)}` } : null;
  },
  imagePaste: { storageDir: path.join(".pi", "pasted"), gitExcludePattern: ".pi/pasted/", inputText: p => `Read this image as visual context: ${JSON.stringify(p)}` },
};
