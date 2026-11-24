import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.js";
import { getOwnedTask, listOwnedTasks, legacyOwnershipReport } from "../core/ownership.js";
import { createDirectoryTask, directoryCwd, directoryDestination, type DirectoryEnv } from "./directory.js";
import { taskControlDir } from "./workspace.js";
import { adoptTaskManifests, readTaskManifests, removeTaskManifest, writeTaskManifestFromDb } from "./taskmanifest.js";
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

test("directory Refs are isolated from a shared cwd, manifested before launch and preserved on resume", async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO repos(id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (1,1,'docs','https://fixture/docs','main','/fixture.git','ready')").run();
  f.env.setupReference = async ({ worktree }) => {
    fs.mkdirSync(worktree, { recursive: true }); fs.writeFileSync(path.join(worktree, "guide.txt"), "pinned");
    return "a".repeat(40);
  };
  const removed: string[] = [];
  f.env.removeReference = async (_mirror, target) => { removed.push(target); fs.rmSync(target, { recursive: true }); };
  const refs = (id: number) => JSON.parse(fs.readFileSync(path.join(f.dataDir, "tasks", String(id), ".tdsp/refs.json"), "utf8"));
  f.env.start = async task => {
    const manifest = refs(task.id);
    assert.equal(manifest.primary.path, fs.realpathSync(f.cwd));
    assert.equal(manifest.references[0].resolved_commit, "a".repeat(40));
    assert.equal(manifest.references[0].mode, "reference");
    assert.equal(fs.readFileSync(path.join(manifest.references[0].path, "guide.txt"), "utf8"), "pinned");
  };
  const options = { agent: "codex" as const, cwd: f.cwd, references: [{ repo_id: 1, alias: "docs" }] };
  const a = await createDirectoryTask(f.env, options), b = await createDirectoryTask(f.env, options);
  const first = refs(a.id).references[0].path, second = refs(b.id).references[0].path;
  assert.notEqual(first, second);
  assert.ok(first.startsWith(path.join(f.dataDir, "tasks", String(a.id))));
  assert.deepEqual(fs.readdirSync(f.cwd), ["keep.txt"]);
  const resumed = await resumeTask({ db: f.db, exists: async p => fs.existsSync(p), hasSession: async () => false,
    startSession: task => f.env.start(task, options), writeManifest: id => writeTaskManifestFromDb(f.dataDir, f.db, id),
  }, a.id);
  assert.equal(resumed.ok, true); assert.equal(refs(a.id).references[0].path, first);
  const cleaned = await cleanupTask({ db: f.db, killSession: async () => {}, removeWorktree: f.env.removeReference,
    writeManifest: id => writeTaskManifestFromDb(f.dataDir, f.db, id),
  }, a.id);
  assert.equal(cleaned.ok, true); assert.deepEqual(removed, [first]);
  assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(second), true);
  assert.deepEqual(refs(a.id).references, []); assert.deepEqual(fs.readdirSync(f.cwd), ["keep.txt"]);
  await assert.rejects(createDirectoryTask(f.env, { ...options, references: [{ repo_id: 999 }] }), /not found/);
  assert.equal(listOwnedTasks(f.db).length, 2);
});

test("failed directory dispatch removes its prepared Refs without touching user files", async t => {
  const f = fixture(t);
  f.db.exec("INSERT INTO repos(id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (1,1,'docs','https://fixture/docs','main','/fixture.git','ready')");
  let snapshot = "";
  f.env.setupReference = async ({ worktree }) => { snapshot = worktree; fs.mkdirSync(worktree, { recursive: true }); return "a".repeat(40); };
  f.env.removeReference = async (_mirror, target) => { fs.rmSync(target, { recursive: true }); };
  f.env.start = async () => { throw new Error("Agent launch failed"); };
  await assert.rejects(createDirectoryTask(f.env, { agent: "codex", cwd: f.cwd, references: [{ repo_id: 1 }] }), /Agent launch failed/);
  assert.equal(fs.existsSync(snapshot), false);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM task_references").get() as any).n, 0);
  assert.deepEqual(fs.readdirSync(f.cwd), ["keep.txt"]);
  assert.equal(listOwnedTasks(f.db)[0].status, "error");
});

test("automatic tasks allocate separate workspaces before preparing or starting an agent", async t => {
  const f = fixture(t);
  f.env.prepare = async task => {
    assert.equal(fs.statSync(task.cwd!).isDirectory(), true);
    fs.writeFileSync(path.join(task.cwd!, "result.txt"), String(task.id));
  };
  const [a, b] = await Promise.all([
    createDirectoryTask(f.env, { agent: "claude" }),
    createDirectoryTask(f.env, { agent: "codex", cwdMode: "managed" }),
  ]);
  assert.notEqual(a.cwd, b.cwd);
  for (const result of [a, b]) {
    assert.equal(result.cwd, fs.realpathSync(path.join(f.dataDir, "workspaces", "tasks", String(result.id))));
    assert.equal(result.cwd_mode, "managed");
    assert.equal(fs.readFileSync(path.join(result.cwd, "result.txt"), "utf8"), String(result.id));
    assert.equal(f.started.find(task => task.id === result.id)?.cwd, result.cwd);
  }
  assert.deepEqual(fs.readdirSync(f.cwd), ["keep.txt"], "home directory is not used implicitly");
});

test("visible work output stays separate from private task metadata", async t => {
  const f = fixture(t);
  f.env.workspaceRoot = path.join(f.root, "Junction", "workspaces", "test");
  const result = await createDirectoryTask(f.env, { agent: "codex" });
  assert.equal(result.cwd, fs.realpathSync(path.join(f.env.workspaceRoot, "tasks", String(result.id))));
  assert.ok(fs.existsSync(path.join(f.dataDir, "tasks", String(result.id), "task.json")));
  assert.equal(fs.existsSync(path.join(f.dataDir, "workspaces")), false);
});

test("ambiguous or missing directory selections are rejected without allocating a task", async t => {
  const f = fixture(t);
  await assert.rejects(createDirectoryTask(f.env, { agent: "codex", cwdMode: "existing" }), /请填写/);
  await assert.rejects(createDirectoryTask(f.env, { agent: "codex", cwdMode: "managed", cwd: f.cwd }), /同时指定/);
  await assert.rejects(directoryDestination({}, undefined), /无效/);
  await assert.rejects(directoryDestination(undefined, "unknown"), /无效/);
  assert.equal(listOwnedTasks(f.db).length, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, "workspaces")), false);
});

test("allocation collision preserves the directory and cannot be resumed as this task", async t => {
  const f = fixture(t);
  const old = path.join(f.dataDir, "workspaces", "tasks", "1");
  fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, "keep.txt"), "older work");
  await assert.rejects(createDirectoryTask(f.env, { agent: "codex" }), /目录已存在/);
  assert.equal(f.started.length, 0);
  assert.equal(listOwnedTasks(f.db)[0].cwd, null);
  assert.equal(fs.readFileSync(path.join(old, "keep.txt"), "utf8"), "older work");
  const result = await resumeTask({ db: f.db, exists: async () => true, hasSession: async () => false,
    startSession: async () => assert.fail("must not enter an unallocated directory"), writeManifest() {} }, 1);
  assert.equal(result.ok, false);
  const next = await createDirectoryTask(f.env, { agent: "codex" });
  assert.equal(path.basename(next.cwd), "2");
});

test("managed work survives agent failure, resume, cleanup and metadata deletion", async t => {
  const f = fixture(t);
  f.env.start = async task => { fs.writeFileSync(path.join(task.cwd!, "work.txt"), "keep"); throw new Error("failed start"); };
  await assert.rejects(createDirectoryTask(f.env, { agent: "codex" }), /failed start/);
  const task = listOwnedTasks(f.db)[0];
  assert.equal(task.status, "error");
  const resumed = await resumeTask({ db: f.db, exists: async p => fs.existsSync(p), hasSession: async () => false,
    startSession: async saved => assert.equal(saved.cwd, task.cwd), writeManifest() {} }, task.id);
  assert.equal(resumed.ok, true);
  assert.equal((await cleanupTask({ db: f.db, killSession: async () => {},
    removeWorktree: async () => assert.fail("ordinary output is not a worktree"), writeManifest() {} }, task.id)).ok, true);
  assert.equal((await deleteTaskRecord({ db: f.db, exists: async p => fs.existsSync(p),
    removeManifest: id => removeTaskManifest(f.dataDir, id) }, task.id)).ok, true);
  assert.equal(fs.existsSync(path.join(f.dataDir, "tasks", String(task.id))), false);
  assert.equal(fs.readFileSync(path.join(task.cwd!, "work.txt"), "utf8"), "keep");
});

test("Context continuation pins the source revision while using its newly allocated destination", async t => {
  const f = fixture(t);
  const snapshot = { meta: { id: "source-context", revision: { id: "source-version", source_sha256: "sha" } },
    normalized: { schema_version: "1", session: { messages: [], turns: [] },
      extensions: { "switchyard.capture/1": { cwd: "/another-device/work" } } } };
  f.env.prepare = async task => {
    const control = taskControlDir(f.dataDir, task);
    const manifest = writeHandoff(control, snapshot, "https://example.test", task.cwd!);
    assert.equal(manifest.working_directory, task.cwd);
    assert.equal(manifest.context_id, "source-context");
    assert.equal(manifest.revision_id, "source-version");
    assert.deepEqual(fs.readdirSync(task.cwd!), []);
  };
  const a = await createDirectoryTask(f.env, { agent: "claude" });
  const b = await createDirectoryTask(f.env, { agent: "codex" });
  assert.notEqual(a.cwd, b.cwd);
  assert.equal(f.started.length, 2);
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
  assert.equal(getOwnedTask(f.db, result.id)?.cwd_mode, "managed");
  assert.equal(getOwnedTask(f.db, result.id)?.cwd, result.cwd);
});

test("resume, cleanup and record deletion never treat a directory as an owned worktree", async t => {
  const f = fixture(t);
  const { id } = await createDirectoryTask(f.env, { agent: "codex", cwd: f.cwd });
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
  const a = await createDirectoryTask(f.env, { agent: "claude", cwd: f.cwd });
  const b = await createDirectoryTask(f.env, { agent: "codex", cwd: f.cwd });
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
