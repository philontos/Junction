import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localRunner, sshBaseArgs, sshControlPath } from "./runner.ts";

test("LocalRunner.putDir copies a directory tree", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pd-"));
  const src = path.join(tmp, "src");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.writeFileSync(path.join(src, "README.md"), "hi");
  fs.writeFileSync(path.join(src, "sub", "x.sh"), "#!/bin/sh\n");
  const dest = path.join(tmp, "out", "tree");      // parent does not exist yet
  await localRunner.putDir(src, dest);
  assert.equal(fs.readFileSync(path.join(dest, "README.md"), "utf8"), "hi");
  assert.ok(fs.existsSync(path.join(dest, "sub", "x.sh")));
});

test("LocalRunner.putFile copies a single file, creating parent dirs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-"));
  const src = path.join(tmp, "a.png");
  fs.writeFileSync(src, "PNGDATA");
  const dest = path.join(tmp, "out", "nested", "b.png"); // parents don't exist yet
  await localRunner.putFile(src, dest);
  assert.equal(fs.readFileSync(dest, "utf8"), "PNGDATA");
});

test("LocalRunner.readText returns file contents, and null when missing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-"));
  const f = path.join(tmp, ".claude", "session-id");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "abc123-de45-6789");
  assert.equal(await localRunner.readText(f), "abc123-de45-6789");
  assert.equal(await localRunner.readText(path.join(tmp, "nope")), null);
});

test("LocalRunner.exec terminates a command at its requested deadline", async () => {
  await assert.rejects(
    localRunner.exec(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { timeoutMs: 50 }),
    (error: any) => error?.name === "TimeoutError" && /50ms/.test(error.message),
  );
});

test("cancelling a Git-like process also stops its child helper", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-command-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const pidFile = path.join(tmp, "helper.pid");
  const controller = new AbortController();
  const running = localRunner.exec(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const helper=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
    require('node:fs').writeFileSync(process.argv[1],String(helper.pid));
    setInterval(()=>{},1000);
  `, pidFile], { signal: controller.signal });
  const rejected = assert.rejects(running, (error: any) => error.name === "AbortError");
  t.after(() => controller.abort());
  for (let i = 0; !fs.existsSync(pidFile) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(pidFile), "helper started");
  const helper = Number(fs.readFileSync(pidFile, "utf8"));
  controller.abort();
  await rejected;
  for (let i = 0; i < 100; i++) {
    try { process.kill(helper, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("the cancelled helper must not remain running");
});

test("sshControlPath stays below macOS's unix-socket limit for deep profiles", () => {
  const deep = "/Users/example/.task-dispatcher/profiles/tailscale-test/data/12345678";
  const controlPath = sshControlPath(deep, 501);
  if (process.platform !== "win32") {
    assert.ok(Buffer.byteLength(controlPath) < 104, controlPath);
    assert.match(controlPath, /^\/tmp\/tdsp-501-[a-f0-9]{12}-%C$/);
    assert.notEqual(controlPath, sshControlPath(`${deep}-other`, 501));
  }
});

test("managed SSH uses a separate mux plus a profile-owned identity and known_hosts", () => {
  const args = sshBaseArgs(true);
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.ok(args.includes("StrictHostKeyChecking=accept-new"));
  assert.ok(args.some((arg) => arg.includes("network/ssh/id_ed25519")));
  assert.ok(args.some((arg) => arg.includes("network/ssh/known_hosts")));
  assert.notEqual(sshControlPath(undefined, 501, true), sshControlPath(undefined, 501, false));
});
