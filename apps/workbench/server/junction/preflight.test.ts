import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { LocalRunner } from "../fleet/runner.js";
import { checkShare } from "./preflight.js";
import type { Task } from "../core/db.js";

test("share checks distinguish dirty files, unpublished commits and remotely reachable history without writing Git", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "junction-share-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"), remote = path.join(root, "remote.git");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" }, stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "--bare", remote); git("init", "--initial-branch=main", repo);
  fs.writeFileSync(path.join(repo, "source.txt"), "version one"); git("-C", repo, "add", "source.txt"); git("-C", repo, "commit", "-m", "fixture");
  git("-C", repo, "remote", "add", "origin", remote);
  const runner = Object.assign(new LocalRunner(), { dataDir: root });
  const task = { id: 42, kind: "repo", worktree_path: repo } as Task;
  assert.equal((await checkShare(runner, task)).publication, "unpublished");
  git("-C", repo, "push", "origin", "main");
  const clean = await checkShare(runner, task);
  assert.equal(clean.publication, "published"); assert.equal(clean.notes.length, 0);
  git("-C", repo, "switch", "-c", "feat/42-task");
  assert.equal((await checkShare(runner, task)).publication, "published", "commit reachable on main needs no duplicate push");
  fs.writeFileSync(path.join(repo, "source.txt"), "version two"); fs.writeFileSync(path.join(repo, "new draft.md"), "draft");
  const before = git("-C", repo, "status", "--porcelain"), sha = git("-C", repo, "rev-parse", "HEAD");
  const dirty = await checkShare(runner, task);
  assert.equal(dirty.dirty, true); assert.equal(dirty.changed_count, 2); assert.ok(dirty.changed_files.includes("new draft.md"));
  assert.equal(git("-C", repo, "status", "--porcelain"), before); assert.equal(git("-C", repo, "rev-parse", "HEAD"), sha);
  git("-C", repo, "add", "source.txt", "new draft.md"); git("-C", repo, "commit", "-m", "local only");
  const unpublished = await checkShare(runner, task); assert.equal(unpublished.dirty, false); assert.equal(unpublished.publication, "unpublished");
  git("-C", repo, "remote", "remove", "origin");
  assert.equal((await checkShare(runner, task)).publication, "unknown");
  assert.equal((await checkShare(runner, { id: 43, kind: "directory", cwd: root } as Task)).publication, "not_applicable");
});
