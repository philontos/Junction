import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import type { Task } from "../core/db.ts";
import type { Runner } from "../fleet/runner.ts";
import { piSessionDir } from "../../../../packages/agent-adapters/node/pi.ts";
import { restartTaskSession } from "./restart.ts";

for (const history of [false, true]) test(`restart ${history ? "resumes its own history" : "retries the original prompt when startup produced no history"}`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jx-restart-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: dir, dataDir: dir });
  t.after(() => db.close());
  const task = { id: 1, kind: "repo", session: "tdsp-fixture-1", agent: "pi", worktree_path: dir,
    prompt: "continue the shared context", agent_model: "fixture-model", provider_id: null, claude_session: null } as Task;
  const native = path.join(piSessionDir(dir, task.session), "session.jsonl");
  if (history) {
    await fs.mkdir(path.dirname(native), { recursive: true });
    await fs.writeFile(native, JSON.stringify({ type: "session", cwd: dir, id: "fixture" }) + "\n");
  }
  const calls: string[][] = [];
  const runner = { kind: "local", dataDir: dir,
    exists: async (file: string) => fs.access(file).then(() => true, () => false),
    exec: async (file: string, args: string[]) => {
      if (file === "sh") return "/fixture/bin/pi";
      calls.push(args);
      return args[0] === "list-panes" ? `${task.session}|%1|1|1|\n` : "";
    },
  } as unknown as Runner;
  await restartTaskSession(db, runner, task);
  const launch = calls.find(args => args[0] === "respawn-pane")!;
  assert.ok(launch);
  assert.equal(launch.includes("-k"), false);
  assert.equal(launch.includes(task.prompt!), !history);
  assert.equal(launch.includes("--session"), history);
  if (history) assert.ok(launch.includes(native));
  assert.ok(launch.includes("fixture-model"));
  assert.equal(calls.some(args => args[0] === "kill-session" || args[0] === "new-session"), false);
});
