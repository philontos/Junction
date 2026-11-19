import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Runner } from "../fleet/runner.js";
import type { Task } from "../core/db.js";
import { startSession } from "../session/tmux.js";
import { readTranscript, locateNativeJsonl } from "../session/transcript.js";
import { agentCatalog, canShareAgent } from "./index.js";
import { piAdapter, piSessionDir, locatePiSession } from "./pi.js";

const exec = promisify(execFile);
const jsonl = (...rows: object[]) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const header = (cwd: string, id = "pi-session") => ({ type: "session", version: 3, id, cwd });
const message = (role: string, content: unknown, extra = {}) => ({ type: "message", id: "entry", parentId: null, message: { role, content, ...extra } });

test("Pi launches interactively and resumes an exact file without resending a prompt or granting permissions", () => {
  const launch = piAdapter.launch({ prompt: "--continue", model: "provider/model", sessionDir: "/private sessions", workspaceInstructions: "read refs.json" });
  assert.deepEqual(launch, ["pi", "--session-dir", "/private sessions", "--append-system-prompt", "read refs.json", "--model", "provider/model", "--", "--continue"]);
  const resume = piAdapter.launch({ resume: true, sessionFile: "/private sessions/one.jsonl", prompt: "never repeat" });
  assert.deepEqual(resume, ["pi", "--session", "/private sessions/one.jsonl"]);
  assert.equal(canShareAgent("pi"), true);
  assert.equal(canShareAgent("kimi"), false);
  assert.equal(canShareAgent("__proto__"), false);
  assert.equal(agentCatalog().find(a => a.id === "pi")?.native_format, "pi-session.jsonl");
});

test("Pi task storage isolates same-cwd sessions; resume fails closed and transcript keeps byte cursors", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "switchyard-pi-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work"); await fs.mkdir(cwd);
  const calls: { file: string; args: string[] }[] = [];
  const runner = {
    kind: "local", dataDir: root,
    async exec(file: string, args: string[]) {
      calls.push({ file, args });
      if (file === "tmux") return ""; // Never touch the user's tmux server.
      if (file === "sh") return "/test/bin/pi\n";
      return (await exec(file, args)).stdout;
    },
  } as Runner;
  await startSession(runner, "task-a", cwd, "继续中文任务", { agent: "pi" });
  const launched = calls.find(c => c.args[0] === "new-session")!.args;
  assert.ok(launched.includes(piSessionDir(root, "task-a")));
  assert.equal(launched.at(-1), "继续中文任务");
  const a = path.join(piSessionDir(root, "task-a"), "a.jsonl");
  const bdir = piSessionDir(root, "task-b"); await fs.mkdir(bdir, { recursive: true });
  const body = jsonl(header(cwd), message("user", "只属于 A"), message("assistant", [{ type: "toolCall", id: "call-a", name: "bash", arguments: { command: "pwd" } }]));
  await fs.writeFile(a, body + '{"type":');
  await fs.writeFile(path.join(bdir, "newer.jsonl"), jsonl(header(cwd, "other"), message("user", "belongs to B")));
  await fs.writeFile(path.join(piSessionDir(root, "task-a"), "wrong-cwd.jsonl"), jsonl(header("/wrong")));
  await fs.symlink(path.join(bdir, "newer.jsonl"), path.join(piSessionDir(root, "task-a"), "link.jsonl"));
  assert.equal(await locatePiSession(root, "task-a", cwd), a);
  const linkedCwd = path.join(root, "work-alias"); await fs.symlink(cwd, linkedCwd);
  assert.equal(await locatePiSession(root, "task-a", linkedCwd), a);
  const task = { id: 17, agent: "pi", kind: "directory", session: "task-a", cwd } as Task;
  assert.equal(await locateNativeJsonl(runner, task), a);
  const first = await readTranscript(runner, task);
  assert.equal(first.agent, "pi");
  assert.equal(first.cursor, Buffer.byteLength(body));
  assert.deepEqual(first.entries.map(e => e.t), ["user", "tool_call"]);
  const result = message("toolResult", [{ type: "text", text: "中文结果" }], { toolCallId: "call-a", isError: true });
  await fs.writeFile(a, body + jsonl(result));
  const next = await readTranscript(runner, task, first.cursor, first.source);
  assert.deepEqual(next.entries, [{ t: "tool_result", id: "call-a", ok: false, output: "中文结果" }]);
  await startSession(runner, "task-a", cwd, "never repeat", { agent: "pi", continue: true });
  assert.ok(calls.filter(c => c.args[0] === "new-session").at(-1)!.args.includes(a));
  const before = calls.filter(c => c.file === "tmux").length;
  await assert.rejects(startSession(runner, "task-empty", cwd, "", { agent: "pi", continue: true }), /未找到此任务/);
  assert.equal(calls.filter(c => c.file === "tmux").length, before);
});

test("Pi reading distinguishes tool calls, reasoning, images and checkpoints", () => {
  const entries = piAdapter.parseLine(message("assistant", [
    { type: "thinking", thinking: "分析" }, { type: "text", text: "done" },
    { type: "image", mimeType: "image/png", data: "private-image" },
  ]));
  assert.deepEqual(entries.map(e => e.t), ["thinking", "assistant", "assistant"]);
  assert.ok(!JSON.stringify(entries).includes("private-image"));
  assert.match(JSON.stringify(piAdapter.parseLine({ type: "compaction", summary: "checkpoint" })), /checkpoint/);
  assert.deepEqual(piAdapter.parseLine({ type: "custom", data: "never execute" }), []);
});
