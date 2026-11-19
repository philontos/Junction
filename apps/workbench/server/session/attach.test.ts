import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { attachCommand } from "./attach.ts";
import { spawnPty } from "./pty.ts";

const BINS = { ssh: "/usr/bin/ssh", mosh: "/opt/homebrew/bin/mosh", tmux: "/opt/homebrew/bin/tmux" };
const host = (kind: string, target: string) => ({ kind, target }) as any;

test("attachCommand: no host (plain local session) attaches via tmux", () => {
  const r = attachCommand(undefined, "tdsp-1-x", BINS);
  assert.equal(r.file, BINS.tmux);
  assert.deepEqual(r.args, ["-u", "attach", "-t", "tdsp-1-x"]);
});

test("attachCommand: a local-kind host also attaches via tmux", () => {
  const r = attachCommand(host("local", ""), "tdsp-2-x", BINS);
  assert.equal(r.file, BINS.tmux);
  assert.deepEqual(r.args, ["-u", "attach", "-t", "tdsp-2-x"]);
});

test("attachCommand: ssh host sshes in and attaches there", () => {
  const r = attachCommand(host("ssh", "me@box"), "tdsp-3-x", BINS);
  assert.equal(r.file, BINS.ssh);
  assert.deepEqual(r.args, ["-t", "me@box", "exec tmux -u attach -t tdsp-3-x"]);
});

test("attachCommand: a discovered host uses the managed identity without a prompt", () => {
  const r = attachCommand({ ...host("ssh", "me@box"), managed_ssh: 1, ssh_port: 22 }, "tdsp-3-x", BINS);
  assert.equal(r.file, BINS.ssh);
  assert.ok(r.args.includes("IdentitiesOnly=yes"));
  assert.ok(r.args.includes("StrictHostKeyChecking=accept-new"));
  assert.deepEqual(r.args.slice(-3), ["-t", "me@box", "exec tmux -u attach -t tdsp-3-x"]);
});

test("attachCommand: mosh host attaches via mosh", () => {
  const r = attachCommand(host("mosh", "me@box"), "tdsp-4-x", BINS);
  assert.equal(r.file, BINS.mosh);
  assert.deepEqual(r.args, ["me@box", "--", "sh", "-c", "exec tmux -u attach -t tdsp-4-x"]);
});

test("web attach preserves UTF-8 when the node service has the C locale", { timeout: 10000 }, async t => {
  if (process.platform === "win32" || spawnSync("tmux", ["-V"]).status !== 0) return t.skip("tmux unavailable");
  // A private socket isolates this check from every user session and tmux config.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-utf8-"));
  const socket = path.join(dir, "socket");
  const tmux = (args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 3000 });
  let created = false;
  t.after(() => {
    if (created) tmux(["kill-session", "-t", "=unicode"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  tmux(["-u", "-f", "/dev/null", "new-session", "-d", "-s", "unicode", "-x", "100", "-y", "24", "/bin/sh", "-c", "printf '中文交接 Context Pi\\n'; exec cat"]);
  created = true;
  const expected = "中文交接 Context Pi";
  for (let n = 0; n < 20; n++) {
    if (tmux(["capture-pane", "-p", "-t", "unicode:0.0"]).includes(expected)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(tmux(["capture-pane", "-p", "-t", "unicode:0.0"]).includes(expected), "source pane must contain intact Unicode");
  const attach = attachCommand(undefined, "unicode", { ...BINS, tmux: "tmux" });
  const env: NodeJS.ProcessEnv = { ...process.env, LANG: "C", LC_ALL: "C", LC_CTYPE: "C" };
  // A service has no parent tmux client. TMUX would imply UTF-8 regardless of locale.
  delete env.TMUX;
  delete env.TMUX_PANE;
  const term = spawnPty(attach.file, ["-S", socket, ...attach.args], {
    name: "xterm-256color", cols: 100, rows: 24, cwd: dir,
    env: env as Record<string, string>,
  });
  try {
    const output = await new Promise<string>(resolve => {
      let data = "";
      const timer = setTimeout(() => resolve(data), 1000);
      term.onData(chunk => { data += chunk; if (data.includes(expected)) { clearTimeout(timer); resolve(data); } });
    });
    assert.ok(output.includes(expected), "web terminal must receive Chinese bytes, not tmux's underscore fallback");
  } finally {
    term.kill(); // Detach only this test client; the session continues running.
  }
  tmux(["has-session", "-t", "=unicode"]);
});
