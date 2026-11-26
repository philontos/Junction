import test from "node:test";
import assert from "node:assert/strict";
import { taskLiveness } from "./runtime.ts";
import type { Task } from "../core/db.ts";
import type { Runner } from "../fleet/runner.ts";

test("HTTP and CLI share one pane probe and ignore stale waiting files after exit/archive", async () => {
  let probes = 0;
  const runner = { kind: "local", dataDir: "/fixture", exec: async () => {
    probes++;
    return "live|%1|0||\ndead|%2|1|1|\narchived|%3|0||\n";
  }, exists: async () => true } as unknown as Runner;
  const tasks = ["live", "dead", "archived", "missing"].map((session, id) => ({
    id, session, kind: "repo", worktree_path: "/fixture/wt", status: session === "archived" ? "cleaned" : "running",
  } as Task));
  const live = await taskLiveness(runner, tasks);
  assert.equal(probes, 1);
  assert.equal(live.get(0)?.waiting, true);
  for (const id of [1, 2, 3]) {
    assert.equal(live.get(id)?.alive, false);
    assert.equal(live.get(id)?.waiting, false);
  }
  assert.deepEqual(live.get(1)?.runtime, { state: "exited", exitCode: 1 });
});
