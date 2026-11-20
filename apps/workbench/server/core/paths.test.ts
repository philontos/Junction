import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveDataDir, resolveWorkspaceRoot } from "./paths.js";

const HOME = "/home/u";

test("defaults to ~/.task-dispatcher when no override is set", () => {
  assert.equal(resolveDataDir({}, HOME), path.join(HOME, ".task-dispatcher"));
});

test("TASK_DISPATCHER_DATA_DIR overrides the default (isolated instance)", () => {
  assert.equal(
    resolveDataDir({ TASK_DISPATCHER_DATA_DIR: "/srv/dispatch-dev" }, HOME),
    "/srv/dispatch-dev",
  );
});

test("a relative override is resolved to an absolute path", () => {
  assert.equal(
    resolveDataDir({ TASK_DISPATCHER_DATA_DIR: "data-dev" }, HOME),
    path.resolve("data-dev"),
  );
});

test("a blank / whitespace override falls back to the default", () => {
  assert.equal(resolveDataDir({ TASK_DISPATCHER_DATA_DIR: "" }, HOME), path.join(HOME, ".task-dispatcher"));
  assert.equal(resolveDataDir({ TASK_DISPATCHER_DATA_DIR: "   " }, HOME), path.join(HOME, ".task-dispatcher"));
});

test("installed workspaces are visible and isolated by stable node identity", () => {
  const data = "/home/u/.switchyard/cloud/server/data/abcd";
  const env = { TASK_DISPATCHER_DATA_DIR: path.dirname(data), SWITCHYARD_CLOUD_MANAGED: "1" };
  assert.equal(resolveWorkspaceRoot(data, env, HOME), "/home/u/Junction/workspaces/abcd");
  assert.notEqual(resolveWorkspaceRoot(data, env, HOME), resolveWorkspaceRoot("/other/efgh", env, HOME));
});

test("isolated dev profiles keep their work files inside the profile", () => {
  assert.equal(resolveWorkspaceRoot("/tmp/dev/abcd", { TASK_DISPATCHER_DATA_DIR: "/tmp/dev" }, HOME), "/tmp/dev/abcd/workspaces");
});

test("a configured workspace root is independent of the metadata root", () => {
  assert.equal(resolveWorkspaceRoot("/metadata/abcd", { JUNCTION_WORKSPACE_ROOT: "~/Projects/Junction" }, HOME), "/home/u/Projects/Junction");
  assert.equal(resolveWorkspaceRoot("/metadata/abcd", { JUNCTION_WORKSPACE_ROOT: "/work" }, HOME), "/work");
  assert.throws(() => resolveWorkspaceRoot("/metadata/abcd", { JUNCTION_WORKSPACE_ROOT: "relative" }, HOME), /绝对路径/);
});
