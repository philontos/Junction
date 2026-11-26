import test from "node:test";
import assert from "node:assert/strict";
import { taskLifecycle, taskRuntimePresentation } from "./task-lifecycle.js";

test("an archived remote task with a retained worktree can resume or remove it", () => {
  assert.deepEqual(taskLifecycle({ status: "cleaned", alive: false, hasWorktree: true }), {
    active: false,
    action: "removeWorktree",
    resumable: true,
    connectable: false,
  });
});

test("an archived remote task without a worktree deletes only its record", () => {
  assert.deepEqual(taskLifecycle({ status: "cleaned", alive: false, hasWorktree: false }), {
    active: false,
    action: "deleteRecord",
    resumable: false,
    connectable: false,
  });
});

test("a live active remote task remains connectable and stoppable", () => {
  assert.deepEqual(taskLifecycle({ status: "running", alive: true, hasWorktree: true }), {
    active: true,
    action: "stop",
    resumable: false,
    connectable: true,
  });
});

test("exited terminals remain readable and resumable without a false green light", () => {
  const task = { status: "running", alive: false, hasWorktree: true, runtime: { state: "exited", exitCode: 1 } };
  assert.equal(taskLifecycle(task).connectable, true);
  assert.equal(taskLifecycle(task).resumable, true);
  const translate = (key, params) => key + (params ? JSON.stringify(params) : "");
  assert.deepEqual(taskRuntimePresentation(task, translate), {
    dot: "error", label: 'task.failedExit · task.exitCode{"code":1}', detail: 'task.failedExit · task.exitCode{"code":1}',
  });
  assert.equal(taskRuntimePresentation({ ...task, runtime: { state: "exited", exitCode: 0 } }, translate).dot, "");
});

test("creating tasks and unknown process state cannot trigger resume", () => {
  for (const task of [
    { status: "creating" }, { runtime: { state: "unknown" } }, { kind: "local" },
  ]) assert.equal(taskLifecycle({ status: "running", alive: false, hasWorktree: true, ...task }).resumable, false);
  assert.equal(taskRuntimePresentation({ status: "running" }, key => key).dot, "", "old nodes without observations never pretend to be live");
});

test("a failed status probe does not block inspecting the recorded terminal", () => {
  const task = { status: "running", alive: false, session: "tdsp-1", hasWorktree: true, runtime: { state: "unknown" } };
  assert.equal(taskLifecycle(task).connectable, true);
  assert.equal(taskLifecycle(task).resumable, false, "unknown state cannot authorize another process");
  assert.equal(taskLifecycle({ ...task, session: "" }).connectable, false);
});
