import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import express from "express";

test("continuation API prepares a cold repo, pins code and installs history before launching the agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "junction-continuation-"));
  const previousData = process.env.TASK_DISPATCHER_DATA_DIR, previousConfig = process.env.SWITCHYARD_JUNCTION_CONFIG;
  process.env.TASK_DISPATCHER_DATA_DIR = path.join(root, "data");
  process.env.SWITCHYARD_JUNCTION_CONFIG = path.join(root, "junction.json");
  const { db } = await import("../core/db.js");
  const { localRunner } = await import("../fleet/runner.js");
  const { registerJunctionRoutes } = await import("./routes.js");
  const remote = path.join(root, "remote.git"), config = path.join(root, "gitconfig");
  const repoUrl = "https://fixture.example/team/repo.git";
  fs.writeFileSync(config, `[url "${remote}"]\n  insteadOf = ${repoUrl}\n`);
  const env = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  const git = (args: string[], input?: string) => execFileSync("git", args, { env: { ...process.env, ...env }, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git(["init", "--bare", "--initial-branch=main", remote]);
  const blob = git(["-C", remote, "hash-object", "-w", "--stdin"], "Reference fixture");
  const tree = git(["-C", remote, "mktree"], `100644 blob ${blob}\tguide.txt\n`);
  const commit = git(["-C", remote, "commit-tree", tree, "-m", "Recorded version"]);
  const latest = git(["-C", remote, "commit-tree", tree, "-p", commit, "-m", "Newer version"]);
  git(["-C", remote, "update-ref", "refs/heads/main", latest]);
  const referenceMirror = path.join(root, "reference.git");
  git(["init", "--bare", referenceMirror]); git(["-C", referenceMirror, "remote", "add", "origin", remote]);
  db.prepare("INSERT OR IGNORE INTO hosts(id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare("INSERT INTO repos (host_id,name,git_url,default_branch,mirror_path,status) VALUES (1,'docs','https://fixture.example/docs.git','main',?,'ready')").run(referenceMirror);
  const referenceId = (db.prepare("SELECT id FROM repos WHERE name='docs'").get() as any).id;
  const cid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", rid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const workspace = { repo_url: repoUrl, branch: "main", commit, dirty: false };
  const context = { id: cid, title: "Fixture", revision: { id: rid, status: "ready", source_sha256: "fixture", message_count: 1, turn_count: 0,
    normalized: { schema_version: "junction.context/1", session: {}, extensions: { "switchyard.workspace/1": workspace } } } };
  const cloud = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, "http://fixture");
    const result = url.pathname.endsWith(rid) ? context : url.pathname.endsWith("/messages")
      ? { items: [{ id: "m1", role: "user", content: [{ kind: "text", text: "Continue fixture" }] }], next_cursor: null }
      : { items: [], next_cursor: null };
    res.end(JSON.stringify(result));
  });
  cloud.listen(0, "127.0.0.1"); await once(cloud, "listening");
  const token = path.join(root, "token"); fs.writeFileSync(token, "fixture-token");
  fs.writeFileSync(process.env.SWITCHYARD_JUNCTION_CONFIG, JSON.stringify({ url: `http://127.0.0.1:${(cloud.address() as any).port}`, default_account: "fixture",
    accounts: [{ id: "fixture", label: "Fixture", token_file: token }] }));
  const app = express(); app.use(express.json()); registerJunctionRoutes(app);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const originalExec = localRunner.exec;
  const launches: string[][] = [];
  localRunner.exec = async (file, args, options = {}) => {
    if (file === "sh" && args.includes('command -v "$1"')) return "/fixture/codex";
    if (file === "tmux") {
      if (args[0] === "new-session") {
        launches.push(args);
        const cwd = args[args.indexOf("-c") + 1];
        const task = db.prepare("SELECT * FROM tasks WHERE session=?").get(args[args.indexOf("-s") + 1]) as any;
        const control = task.kind === "directory" ? path.join(localRunner.dataDir, "tasks", String(task.id)) : cwd;
        const manifest = JSON.parse(fs.readFileSync(path.join(control, ".tdsp/context/manifest.json"), "utf8"));
        const refs = JSON.parse(fs.readFileSync(path.join(control, ".tdsp/refs.json"), "utf8"));
        assert.equal(refs.references[0].alias, "docs");
        assert.equal(refs.references[0].resolved_commit, latest);
        const refPath = path.resolve(cwd, refs.references[0].path);
        assert.equal(fs.readFileSync(path.join(refPath, "guide.txt"), "utf8"), "Reference fixture");
        assert.equal(fs.existsSync(path.join(refPath, ".git")), false);
        if (task.kind === "directory") assert.ok(args.includes(control), "agent gets the task control directory");
        assert.equal(manifest.revision_id, rid);
        if (task.kind === "repo") assert.equal(git(["-C", cwd, "rev-parse", "HEAD"]), commit);
        assert.ok(args.includes("codex") || args.includes("/fixture/codex"));
      }
      return ""; // Never start or inspect any real task session in this test.
    }
    return originalExec.call(localRunner, file, args, { ...options, env: { ...options.env, ...env } });
  };
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}/api/junction/continue`;
    const body = { context_id: cid, revision_id: rid, workspace_mode: "context", agent: "codex", acknowledge: true, references: [{ repo_id: referenceId, ref: "main", alias: "docs" }] };
    const invalid = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, references: [{ repo_id: 999 }] }) });
    assert.equal(invalid.status, 400); assert.equal(launches.length, 0);
    const response = await fetch(url + "?stream=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.at(-1).type, "complete", JSON.stringify(events));
    assert.deepEqual(events.filter(e => e.type === "progress").map(e => e.stage), ["context", "repository", "fetch", "worktree", "agent"]);
    const result = events.at(-1).result;
    assert.equal(result.context_id, cid); assert.equal(result.revision_id, rid);
    const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(result.id) as any;
    assert.equal(task.kind, "repo"); assert.equal(task.base_commit, commit); assert.equal(task.status, "running");
    assert.equal(launches.length, 1);
    workspace.commit = "c".repeat(40);
    const failed = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(failed.status, 409);
    assert.match((await failed.json() as any).error, /来源设备推送/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM repos").get() as any).n, 2);
    assert.equal((db.prepare("SELECT count(*) AS n FROM tasks").get() as any).n, 1);
    assert.equal(launches.length, 1);
    workspace.commit = commit;
    const directory = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, workspace_mode: undefined, cwd_mode: "managed" }) });
    assert.equal(directory.status, 201, await directory.text());
    assert.equal(launches.length, 2);
  } finally {
    localRunner.exec = originalExec; server.closeAllConnections(); server.close(); cloud.closeAllConnections(); cloud.close(); db.close();
    if (previousData === undefined) delete process.env.TASK_DISPATCHER_DATA_DIR; else process.env.TASK_DISPATCHER_DATA_DIR = previousData;
    if (previousConfig === undefined) delete process.env.SWITCHYARD_JUNCTION_CONFIG; else process.env.SWITCHYARD_JUNCTION_CONFIG = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
