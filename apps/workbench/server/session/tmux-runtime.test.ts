import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { startSession, hasSession } from "./tmux.ts";
import { readSessionRuntimes } from "./runtime.ts";
import type { Runner } from "../fleet/runner.ts";

test("retained exit is readable and can restart without replacing another live process", { timeout: 10000 }, async t => {
  if (spawnSync("tmux", ["-V"]).status !== 0) return t.skip("tmux unavailable");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-runtime-"));
  const socket = path.join(dir, "socket");
  const env: NodeJS.ProcessEnv = { ...process.env, LANG: "C", LC_ALL: "C" };
  delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", timeout: 3000 });
  t.after(() => {
    for (const session of ["fixture", "sibling"]) {
      spawnSync("tmux", ["-S", socket, "kill-session", "-t", "=" + session]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  tmux(["-f", "/dev/null", "new-session", "-d", "-s", "sibling", "/bin/sleep", "60"]);
  const siblingPid = tmux(["list-panes", "-t", "=sibling", "-F", "#{pane_pid}"]);
  const fixture = path.join(dir, "agent.cjs");
  const stop = path.join(dir, "exit");
  fs.writeFileSync(fixture, `const fs = require('node:fs'); console.log('fixture started');
    setInterval(() => { if (fs.existsSync(process.env.FIXTURE_STOP)) { console.log('fixture failure'); process.exit(7); } }, 10);`);
  const runner = { kind: "local", exec: async (file: string, args: string[]) => {
    assert.equal(file, "tmux"); return tmux(args);
  } } as unknown as Runner;
  const options = { binary: process.execPath, env: { FIXTURE_STOP: stop } };
  await startSession(runner, "fixture", dir, fixture, options);
  assert.equal(await hasSession(runner, "fixture"), true);
  fs.writeFileSync(stop, "");
  let snapshot = await readSessionRuntimes(runner);
  for (let n = 0; n < 100 && snapshot.get("fixture").state !== "exited"; n++) {
    await new Promise(resolve => setTimeout(resolve, 20)); snapshot = await readSessionRuntimes(runner);
  }
  assert.deepEqual(snapshot.get("fixture"), { state: "exited", exitCode: 7 });
  assert.equal(await hasSession(runner, "fixture"), false);
  const pane = snapshot.exitedPane("fixture")!;
  assert.ok(tmux(["capture-pane", "-p", "-t", pane]).includes("fixture failure"));
  fs.unlinkSync(stop);
  await startSession(runner, "fixture", dir, fixture, { ...options, restartExited: true });
  assert.equal(await hasSession(runner, "fixture"), true);
  assert.equal(tmux(["list-panes", "-t", "=fixture", "-F", "#{pane_id}"]).trim(), pane);
  const pid = tmux(["list-panes", "-t", "=fixture", "-F", "#{pane_pid}"]);
  await assert.rejects(() => startSession(runner, "fixture", dir, fixture, { ...options, restartExited: true }), /已经在运行/);
  assert.equal(tmux(["list-panes", "-t", "=fixture", "-F", "#{pane_pid}"]), pid);
  assert.equal(tmux(["list-panes", "-t", "=sibling", "-F", "#{pane_pid}"]), siblingPid);
});
