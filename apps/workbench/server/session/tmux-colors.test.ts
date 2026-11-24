import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { startSession } from "./tmux.ts";
import type { Runner } from "../fleet/runner.ts";

test("interactive agents ignore tmux's inherited NO_COLOR but honor a task override", { timeout: 10000 }, async t => {
  if (process.platform === "win32" || spawnSync("tmux", ["-V"]).status !== 0) return t.skip("tmux unavailable");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-colors-"));
  const socket = path.join(dir, "socket");
  const env = { ...process.env };
  delete env.NO_COLOR;
  delete env.TMUX;
  delete env.TMUX_PANE;
  const tmux = (args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", timeout: 3000 });
  t.after(() => {
    for (const name of ["color", "override", "seed"]) {
      if (spawnSync("tmux", ["-S", socket, "has-session", "-t", "=" + name]).status === 0) {
        tmux(["kill-session", "-t", "=" + name]);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Reproduce a server first started by an agent tool, then reused by a clean
  // launchd node. This socket never touches the user's tmux server or sessions.
  execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "seed", "/bin/sleep", "60"], {
    env: { ...env, NO_COLOR: "1" }, timeout: 3000,
  });
  const fixture = path.join(dir, "agent.cjs");
  fs.writeFileSync(fixture, `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.FIXTURE_RESULT, JSON.stringify({ noColor: process.env.NO_COLOR ?? null, model: process.env.ANTHROPIC_MODEL, tty: !!process.stdout.isTTY }));
    process.stdout.write(process.env.NO_COLOR ? 'color-probe' : '\\x1b[32mcolor-probe\\x1b[0m');
    setInterval(() => {}, 1000);
  `);
  const runner = { kind: "local", exec: async (file: string, args: string[]) => {
    assert.equal(file, "tmux");
    return tmux(args);
  } } as unknown as Runner;
  for (const [session, noColor] of [["color", null], ["override", "1"]] as const) {
    const output = path.join(dir, session + ".json");
    await startSession(runner, session, dir, fixture, {
      binary: process.execPath,
      env: { FIXTURE_RESULT: output, ANTHROPIC_MODEL: "fixture-model", ...(noColor ? { NO_COLOR: noColor } : {}) },
    });
    for (let n = 0; n < 100 && !fs.existsSync(output); n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), { noColor, model: "fixture-model", tty: true });
    let pane = "";
    for (let n = 0; n < 100; n++) {
      pane = tmux(["capture-pane", "-e", "-p", "-t", session]);
      if (pane.includes("color-probe")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(pane.includes("color-probe"));
    assert.equal(pane.includes("\x1b[32m"), noColor === null);
  }
  assert.equal(tmux(["show-environment", "-g", "NO_COLOR"]).trim(), "NO_COLOR=1", "the shared server environment stays untouched");
});
