import test from "node:test";
import assert from "node:assert/strict";
import { readSessionRuntimes } from "./runtime.ts";
import { hasSession } from "./tmux.ts";
import type { CommandRunner } from "../fleet/runner.ts";

const runner = (output: string): CommandRunner => ({ kind: "local", exec: async () => output });
test("pane observations distinguish clean exit, failure, signal and mixed live panes", async () => {
  const snapshot = await readSessionRuntimes(runner([
    "a\t%0\t1\t0\t", "b\t%1\t1\t1\t", "c\t%2\t1\t\t15",
    "d\t%3\t1\t1\t", "d\t%4\t0\t\t",
  ].join("\n")));
  assert.deepEqual(snapshot.get("a"), { state: "exited", exitCode: 0 });
  assert.deepEqual(snapshot.get("b"), { state: "exited", exitCode: 1 });
  assert.deepEqual(snapshot.get("c"), { state: "exited", signal: "15" });
  assert.deepEqual(snapshot.get("d"), { state: "running" });
  assert.equal(snapshot.exitedPane("a"), "%0");
  assert.equal(snapshot.exitedPane("d"), null);
  assert.deepEqual(snapshot.get("missing"), { state: "missing" });
});

test("probe failure is unknown and cannot authorize a restart; no server is missing", async () => {
  for (const message of ["timed out", "permission denied", "no server running on /tmp/tmux"]) {
    const failing: CommandRunner = { kind: "local", exec: async () => { throw new Error(message); } };
    const expected = message.startsWith("no server") ? "missing" : "unknown";
    assert.equal((await readSessionRuntimes(failing)).get("task").state, expected);
    if (expected === "unknown") await assert.rejects(() => hasSession(failing, "task"), /无法确认/);
  }
  assert.equal((await readSessionRuntimes(runner("bad output"))).get("task").state, "unknown");
});
