import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.js";
import { getOwnedTask, listOwnedTasks, legacyOwnershipReport } from "../core/ownership.js";
import { createDirectoryTask, directoryCwd, type DirectoryEnv } from "./directory.js";
import { taskControlDir } from "./workspace.js";
import { adoptTaskManifests, readTaskManifests } from "./taskmanifest.js";
import { cleanupTask, deleteTaskRecord, resumeTask } from "./lifecycle.js";
import { agentArgv } from "../session/agent.js";
import { writeHandoff, handoffPrompt } from "../junction/handoff.js";

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-directory-"));
  const cwd = path.join(root, "user work's files"), dataDir = path.join(root, "node");
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, "keep.txt"), "owned by user");
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/unused", dataDir });
  db.exec("INSERT INTO hosts(id,name,target,kind,status) VALUES(1,'local','','local','online'),(2,'other','other','ssh','online')");
  t.after(() => { db.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const started: any[] = [], stopped: string[] = [];
  const env: DirectoryEnv = { db, dataDir, ns: "test", home: cwd,
    start: async task => { started.push(task); }, stop: async session => { stopped.push(session); } };
  return { root, cwd, dataDir, db, env, started, stopped };
}

test("directory tasks require no repository and keep separate sessions in a shared cwd", async t => {
  const f = fixture(t);
  const a = await createDirectoryTask(f.env, { agent: "claude", cwd: "~" });
  const b = await createDirectoryTask(f.env, { agent: "claude", cwd: f.cwd });
  assert.equal(a.cwd, fs.realpathSync(f.cwd));
  assert.notEqual(a.session, b.session);
  assert.notEqual(f.started[0].claude_session, f.started[1].claude_session);
  assert.equal(getOwnedTask(f.db, a.id)?.worktree_path, "");
  assert.equal(getOwnedTask(f.db, a.id)?.repo_id, 0);
  assert.equal(listOwnedTasks(f.db).length, 2);
  assert.equal(legacyOwnershipReport(f.db).orphan_tasks.length, 0);
  f.db.prepare("UPDATE tasks SET host_id=2 WHERE id=?").run(b.id);
  assert.equal(getOwnedTask(f.db, b.id), undefined, "other node's directory is not owned locally");
  assert.deepEqual(fs.readdirSync(f.cwd), ["keep.txt"], "no project configuration overwritten");
});

test("missing and file destinations are rejected before inserting any task", async t => {
  const f = fixture(t);
  await assert.rejects(createDirectoryTask(f.env, { agent: "codex", cwd: path.join(f.cwd, "absent") }), /不存在/);
  await assert.rejects(directoryCwd(path.join(f.cwd, "keep.txt")), /不存在/);
  assert.equal(listOwnedTasks(f.db).length, 0);
});

test("launch failure records an error, stops only its session and leaves user files intact", async t => {
  const f = fixture(t);
  f.env.start = async () => { throw new Error("agent unavailable"); };
  await assert.rejects(createDirectoryTask(f.env, { agent: "codex", cwd: f.cwd }), /agent unavailable/);
  assert.equal(listOwnedTasks(f.db)[0].status, "error");
  assert.equal(f.stopped.length, 1);
  assert.equal(readTaskManifests(f.dataDir)[0].task.status, "error");
  assert.equal(fs.readFileSync(path.join(f.cwd, "keep.txt"), "utf8"), "owned by user");
});

test("directory task manifests are recoverable without repo metadata", async t => {
  const f = fixture(t);
  const result = await createDirectoryTask(f.env, { agent: "codex" });
  const manifests = readTaskManifests(f.dataDir);
  f.db.exec("DELETE FROM tasks");
  assert.equal(adoptTaskManifests(f.db, manifests), 1);
  assert.equal(getOwnedTask(f.db, result.id)?.kind, "directory");
});

test("resume, cleanup and record deletion never treat a directory as an owned worktree", async t => {
  const f = fixture(t);
  const { id } = await createDirectoryTask(f.env, { agent: "codex" });
  const activeDelete = await deleteTaskRecord({ db: f.db, exists: async p => fs.existsSync(p), removeManifest() {} }, id);
  assert.equal(activeDelete.ok, false, "a live directory task must keep its session binding");
  const resumed = await resumeTask({ db: f.db, exists: async p => fs.existsSync(p), hasSession: async () => false,
    startSession: async task => assert.equal(task.cwd, fs.realpathSync(f.cwd)), writeManifest() {} }, id);
  assert.equal(resumed.ok, true);
  const clean = await cleanupTask({ db: f.db, killSession: async s => { f.stopped.push(s); },
    removeWorktree: async () => { assert.fail("must not remove user directory"); }, writeManifest() {} }, id);
  assert.equal(clean.ok, true);
  const deleted = await deleteTaskRecord({ db: f.db, exists: async p => fs.existsSync(p), removeManifest() {} }, id);
  assert.equal(deleted.ok, true);
  assert.equal(fs.readFileSync(path.join(f.cwd, "keep.txt"), "utf8"), "owned by user");
});

test("explicit session ids replace cwd-based latest on resume", () => {
  for (const agent of ["claude", "codex", "kimi"] as const) {
    const argv = agentArgv(agent, { resume: true, sessionId: "exact-session" });
    assert.ok(argv.includes("exact-session"));
    assert.ok(!argv.includes("--last") && !argv.includes("--continue"));
  }
  const argv = agentArgv("claude", { sessionId: "new-id", claudeSettings: "/private/task/settings.json" });
  assert.ok(argv.includes("--session-id"));
  assert.ok(argv.includes("/private/task/settings.json"));
});

test("two Context handoffs into one cwd have independent archives and check the selected directory", async t => {
  const f = fixture(t);
  const a = await createDirectoryTask(f.env, { agent: "claude" });
  const b = await createDirectoryTask(f.env, { agent: "codex" });
  const normalized = { schema_version: "1", session: { messages: [], turns: [] }, extensions: {} };
  const snapshot = { meta: { id: "context", revision: { id: "revision", source_sha256: "sha" } }, normalized };
  for (const result of [a, b]) {
    const task = getOwnedTask(f.db, result.id)!;
    const control = taskControlDir(f.dataDir, task);
    const manifest = writeHandoff(control, snapshot, "https://example.test", task.cwd!);
    assert.equal(manifest.working_directory, task.cwd);
    const reader = path.join(control, ".tdsp/context/read.mjs");
    const info = JSON.parse(execFileSync(process.execPath, [reader, "info"], { cwd: f.cwd, encoding: "utf8" }));
    assert.equal(info.message_count, 0);
    assert.ok(handoffPrompt("", path.dirname(reader)).includes(path.dirname(reader)));
    const skill = fs.readFileSync(path.join(path.dirname(reader), "SKILL.md"), "utf8");
    assert.ok(skill.includes(reader));
  }
  assert.deepEqual(fs.readdirSync(f.cwd), ["keep.txt"]);
});
