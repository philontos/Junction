import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initSchema } from "../core/schema.js";
import { LocalRunner, type Runner } from "../fleet/runner.js";
import { addWorktreeFromBranch } from "../repo/git.js";
import { contextCloneUrl, contextRepository, prepareContextRepository } from "./repository.js";

function fixture(t: any) {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/fixture" });
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'Local','','local','online'),(2,'Remote','remote','ssh','online')").run();
  t.after(() => db.close());
  const calls: string[][] = [];
  const runner: Runner = {
    kind: "local", dataDir: "/fixture",
    async exec(_file, args) {
      calls.push(args);
      if (args[0] === "ls-remote") return `ref: refs/heads/main\tHEAD\n${"a".repeat(40)}\trefs/heads/main\n`;
      return "";
    },
    async mkdirp() {}, async exists() { return false; }, async rmrf() {},
    async readText() { return null; }, async putDir() {}, async putFile() {},
  };
  const insert = (url: string, status = "ready", host = 1) => Number(db.prepare(
    "INSERT INTO repos(host_id,name,git_url,default_branch,mirror_path,status,token) VALUES (?,'sample',?,'main','/fixture/mirror',?,'local-secret')",
  ).run(host, url, status).lastInsertRowid);
  return { db, runner, calls, insert, syncRepos() {} };
}
const source = { repoUrl: "https://github.example/org/sample.git", commit: null, branch: "main", dirty: false };

test("automatically registers a missing repo on this device and reuses it on retry", async t => {
  const env = fixture(t);
  env.insert(source.repoUrl, "ready", 2);
  const repo = await prepareContextRepository(env, source, undefined);
  assert.equal(repo.host_id, 1);
  assert.equal(repo.name, "sample");
  assert.equal(repo.token, null);
  assert.equal((await prepareContextRepository(env, source, undefined)).id, repo.id);
  assert.equal(env.calls.filter(c => c[0] === "init").length, 1);
});

test("matches SSH to HTTPS without changing local authentication", async t => {
  const env = fixture(t);
  const id = env.insert("git@github.example:org/sample.git");
  const repo = await prepareContextRepository(env, source, undefined);
  assert.equal(repo.id, id);
  assert.equal(repo.token, "local-secret");
  assert.equal(env.calls.length, 0);
});

test("duplicate remotes reuse the oldest ready repo and in-progress setups do not duplicate", async t => {
  const env = fixture(t);
  const id = env.insert(source.repoUrl);
  const second = env.insert("git@github.example:org/sample.git");
  assert.equal((await prepareContextRepository(env, source, undefined)).id, id);
  assert.equal((await prepareContextRepository(env, source, second)).id, second);
  env.db.prepare("UPDATE repos SET status='error' WHERE id=?").run(id);
  assert.equal((await prepareContextRepository(env, source, undefined)).id, second);
  env.db.prepare("UPDATE repos SET status='cloning'").run();
  await assert.rejects(prepareContextRepository(env, source, undefined), /正在准备/);
  assert.equal(env.calls.length, 0);
});

test("concurrent automatic setup registers only once", async t => {
  const env = fixture(t);
  const first = prepareContextRepository(env, source, undefined);
  await assert.rejects(prepareContextRepository(env, source, undefined), /正在准备/);
  const repo = await first;
  assert.equal((await prepareContextRepository(env, source, undefined)).id, repo.id);
  assert.equal(env.calls.filter(c => c[0] === "init").length, 1);
});

test("failed registration retry preserves its local ID and credentials, redacting errors", async t => {
  const env = fixture(t);
  const id = env.insert("git@github.example:org/sample.git", "error");
  const original = env.runner.exec;
  env.runner.exec = async () => { throw new Error("Authentication failed https://user:secret@github.example/org/sample"); };
  await assert.rejects(prepareContextRepository(env, source, undefined), error => {
    assert.match(String(error), /Git 访问权限/); assert.doesNotMatch(String(error), /user:secret/); return true;
  });
  env.runner.exec = original;
  const repo = await prepareContextRepository(env, source, undefined);
  assert.equal(repo.id, id);
  assert.equal(repo.token, "local-secret");
  assert.equal(repo.git_url, "git@github.example:org/sample.git");
});

test("rejects remote-owned or unrelated selected repos before Git operations", async t => {
  const env = fixture(t);
  const remote = env.insert(source.repoUrl, "ready", 2);
  const other = env.insert("https://github.example/org/other.git");
  await assert.rejects(prepareContextRepository(env, source, remote), /当前设备/);
  await assert.rejects(prepareContextRepository(env, source, other), /不一致/);
  assert.equal(env.calls.length, 0);
});

test("automatic setup rejects source-device paths and executable helpers", () => {
  for (const url of ["/Users/source/repo", "file:///repo", "ext::sh -c evil", "-oProxyCommand=evil", "ssh://host/repo\narg"]) {
    assert.throws(() => contextCloneUrl(url), /仓库/);
  }
  assert.equal(contextCloneUrl("https://user:token@host/org/repo.git?token=secret"), "https://host/org/repo.git");
  assert.equal(contextCloneUrl("ssh://git@host/org/repo.git"), "ssh://git@host/org/repo.git");
  assert.equal(contextCloneUrl("git@host:org/repo.git"), "git@host:org/repo.git");
});

test("partial captures preserve a valid commit without inventing missing repository data", () => {
  const commit = "b".repeat(40);
  assert.deepEqual(contextRepository({ extensions: { "switchyard.capture/1": { repo_url: source.repoUrl, commit, branch: "HEAD", dirty: null } } }),
    { repoUrl: source.repoUrl, commit, branch: null, dirty: null });
  assert.equal(contextRepository({}).repoUrl, "");
});

test("missing source commit is an actionable error; no fallback to main", async t => {
  const env = fixture(t);
  env.insert(source.repoUrl);
  env.runner.exec = async (_file, args) => {
    env.calls.push(args);
    if (args[0] === "cat-file") throw new Error("not found");
    if (args[0] === "fetch") throw new Error("upload-pack: not our ref");
    return "";
  };
  await assert.rejects(prepareContextRepository(env, { ...source, commit: "b".repeat(40) }, undefined), /来源设备推送/);
  assert.equal(env.calls.some(c => c.some(a => a.includes("refs/heads/main"))), false);
});

test("cancelled setup does not register a repository", async t => {
  const env = fixture(t);
  await assert.rejects(prepareContextRepository(env, source, undefined, undefined, AbortSignal.abort()));
  assert.equal(env.calls.length, 0);
  assert.equal((env.db.prepare("SELECT count(*) AS n FROM repos").get() as any).n, 0);
});

test("real cold repo setup checks out the recorded commit, not the newer main tip", async t => {
  const env = fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "junction-context-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "source.git"), config = path.join(root, "gitconfig");
  const isolated = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  fs.writeFileSync(config, `[url "${remote}"]\n  insteadOf = ${source.repoUrl}\n`);
  const git = (args: string[], input?: string) => execFileSync("git", args, { env: { ...process.env, ...isolated }, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
  git(["init", "--bare", "--initial-branch=main", remote]);
  const tree = git(["-C", remote, "mktree"], "");
  const commit = git(["-C", remote, "commit-tree", tree, "-m", "Source context"]);
  const latest = git(["-C", remote, "commit-tree", tree, "-p", commit, "-m", "Newer main"]);
  git(["-C", remote, "update-ref", "refs/heads/main", latest]);
  const runner = new LocalRunner(); runner.dataDir = path.join(root, "data");
  const exec = runner.exec.bind(runner);
  runner.exec = (file, args, options = {}) => exec(file, args, { ...options, env: { ...options.env, ...isolated } });
  const repo = await prepareContextRepository({ ...env, runner }, { ...source, commit }, undefined);
  const destination = path.join(root, "workspace");
  await addWorktreeFromBranch(runner, repo.mirror_path!, destination, "continue-task", commit);
  assert.equal(git(["-C", destination, "rev-parse", "HEAD"]), commit);
  assert.notEqual(commit, latest);
  assert.equal((await prepareContextRepository({ ...env, runner }, { ...source, commit }, undefined)).id, repo.id);
});
