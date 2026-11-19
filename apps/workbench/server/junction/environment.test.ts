import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectEnvironment, checkEnvironment, boundEnvironment, emptyEnvironment, ENVIRONMENT_EXTENSION } from "./environment-runtime.mjs";
import { pinEnvironment } from "./environment.js";
import { writeHandoff } from "./handoff.js";

function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junction-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "project"); fs.mkdirSync(cwd);
  return { dir, cwd };
}
const raw = Buffer.from(JSON.stringify({ type: "assistant", version: "2.1.300", timestamp: "2026-11-18T08:00:00Z",
  message: { content: [
    { type: "tool_use", name: "Bash", input: { command: "ssh devbox uptime" } },
    { type: "tool_use", name: "Skill", input: { skill: "test-helper" } },
    { type: "tool_use", name: "Read", input: { file_path: "/old/project/data.csv" } },
    { type: "tool_use", name: "Read", input: { file_path: "/old/project/.env" } },
  ] } }) + "\n");

test("capture preserves the complete v-prefixed Node runtime version", async t => {
  const { cwd } = fixture(t);
  const previous = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath) + path.delimiter + (previous || "");
  try {
    const environment = await collectEnvironment({ cwd, raw: Buffer.alloc(0), agent: "codex" });
    const node = environment.groups.runtimes.items.find(i => i.id === "node");
    assert.equal(node.observed.value.version, process.versions.node);
  } finally { process.env.PATH = previous; }
});

test("capture retains task evidence and unknown access, without environment values or config contents", async t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ engines: { node: ">=22" }, secret: "PACKAGE_SECRET_CANARY" }));
  fs.writeFileSync(path.join(cwd, ".env.example"), "API_TOKEN=ENV_SECRET_CANARY\nPORT=1234\n");
  fs.writeFileSync(path.join(cwd, ".env"), "DO_NOT_READ=PRIVATE_CANARY");
  const result = await collectEnvironment({ cwd, raw, agent: "claude", workspaceExtension: "switchyard.workspace/1" });
  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /SECRET_CANARY|PRIVATE_CANARY|DO_NOT_READ|1234/);
  assert.equal(result.scope.probe_context, "switchyard_process");
  assert.equal(result.groups.agent.items[0].observed.value.version, "2.1.300");
  assert.equal(result.groups.agent.items[0].observed.source.observed_at, "2026-11-18T08:00:00.000Z");
  assert.deepEqual(result.groups.variables.items.map(i => i.id), ["API_TOKEN", "PORT"]);
  assert.equal(result.groups.variables.items[0].observed.status, "unknown");
  assert.equal(result.groups.access.items[0].observed.status, "unknown");
  assert.equal(result.groups.skills.items[0].id, "test-helper");
  assert.equal(result.groups.resources.items.length, 1);
  const pkg = result.groups.dependencies.items[0];
  assert.equal(pkg.observed.value.engines.node, ">=22");
  assert.match(pkg.observed.value.sha256, /^[a-f0-9]{64}$/);
  assert.equal(pkg.requirement, undefined); // Declared engines != every observed runtime is required.
});

test("Codex native calls are evidence, not proof tools are currently installed", async t => {
  const { cwd } = fixture(t);
  const log = [
    { type: "session_meta", payload: { cli_version: "0.66.0" } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"echo test"}' } },
    { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "unparsed" } },
  ].map(e => JSON.stringify(e)).join("\n");
  const result = await collectEnvironment({ cwd, agent: "codex", raw: Buffer.from("null\n[]\n{broken\n" + log) });
  assert.equal(result.groups.agent.items[0].observed.source.observed_at, null);
  assert.deepEqual(result.groups.tools.items.map(i => [i.id, i.observed.status]), [["apply_patch", "unknown"], ["cli:echo", "unknown"], ["exec_command", "unknown"]]);
});

test("capture bounds reads and records escaping symlinks and oversized files as unknown", async t => {
  const { cwd, dir } = fixture(t);
  fs.writeFileSync(path.join(dir, "secret"), "SYMLINK_SECRET_CANARY");
  fs.symlinkSync(path.join(dir, "secret"), path.join(cwd, "package.json"));
  fs.writeFileSync(path.join(cwd, "yarn.lock"), Buffer.alloc(2 * 1024 * 1024 + 1));
  const result = await collectEnvironment({ cwd, agent: "claude" });
  assert.equal(result.groups.dependencies.coverage, "partial");
  assert.deepEqual(result.groups.dependencies.items.map(i => [i.id, i.observed.status, i.observed.reason]),
    [["package.json", "unknown", "outside_workspace"], ["yarn.lock", "unknown", "file_too_large"]]);
  assert.doesNotMatch(JSON.stringify(result), /SYMLINK_SECRET/);
});

test("a removed worktree does not turn unknown dependencies into an empty successful scan", async t => {
  const { cwd } = fixture(t);
  fs.rmdirSync(cwd);
  const result = await collectEnvironment({ cwd, agent: "claude", raw });
  for (const key of ["dependencies", "runtimes", "variables"]) {
    assert.equal(result.groups[key].coverage, "not_collected");
    assert.equal(result.groups[key].reason, "workspace_unavailable");
  }
  assert.equal(result.groups.agent.items[0].observed.value.version, "2.1.300");
});

test("runtime probes time out and ignore project executables, including external symlinks to them", async t => {
  const { cwd, dir } = fixture(t), oldPath = process.env.PATH;
  const bin = path.join(dir, "bin"), local = path.join(cwd, "bin");
  fs.mkdirSync(bin); fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, "node"), "#!/bin/sh\ntouch \"" + path.join(cwd, "EXECUTED") + "\"\n", { mode: 0o700 });
  fs.symlinkSync(path.join(local, "node"), path.join(bin, "node"));
  fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\nexec /bin/sleep 8\n", { mode: 0o700 });
  process.env.PATH = [local, bin].join(path.delimiter);
  try {
    const started = Date.now(), result = await collectEnvironment({ cwd, agent: "claude" });
    assert.ok(Date.now() - started < 4000);
    assert.equal(result.groups.runtimes.items.find(i => i.id === "node").observed.status, "missing");
    assert.equal(result.groups.runtimes.items.find(i => i.id === "python").observed.reason, "timeout");
    assert.equal(fs.existsSync(path.join(cwd, "EXECUTED")), false);
    assert.equal(result.groups.system.coverage, "collected");
  } finally { process.env.PATH = oldPath; }
});

test("metadata bounds preserve omission information and fit the service and request-line budgets", async t => {
  const { cwd } = fixture(t), environment = emptyEnvironment(cwd);
  environment.groups.resources = { coverage: "partial", items: Array.from({ length: 40 }, (_, i) => ({
    id: i + "中文资源".repeat(80), observed: { status: "unknown", source: { kind: "log_record" } },
  })) };
  const other = { "switchyard.workspace/1": { repo_url: "https://example.org/project.git", branch: "分支" } };
  const limited = boundEnvironment(environment, other), metadata = { ...other, [ENVIRONMENT_EXTENSION]: limited };
  const ascii = JSON.stringify(metadata).replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  assert.ok(ascii.length + (ascii.match(/[:,]/g)?.length || 0) < 8192);
  assert.ok(new URLSearchParams({ extensions: JSON.stringify(metadata) }).toString().length <= 11000);
  assert.ok(limited.groups.resources.omitted_count > 0);
  assert.equal(environment.groups.resources.items.length, 40);
});

test("identical concurrent shares and retries reuse a timestamp; changed evidence creates a new snapshot", async t => {
  const { cwd, dir } = fixture(t), first = emptyEnvironment(cwd);
  const later = { ...first, captured_at: "2026-11-19T00:00:00Z" };
  const cache = path.join(dir, "cache"), other = { "workspace/1": { commit: "a" } };
  const [a, b] = await Promise.all([pinEnvironment(cache, raw, other, first), pinEnvironment(cache, raw, other, later)]);
  assert.deepEqual(a, b);
  assert.deepEqual(await pinEnvironment(cache, raw, other, later), a);
  const changed = structuredClone(later); changed.groups.system.coverage = "partial";
  assert.equal((await pinEnvironment(cache, raw, other, changed)).captured_at, later.captured_at);
  assert.equal((await pinEnvironment(cache, Buffer.from("new log"), other, later)).captured_at, later.captured_at);
});

test("handoff checks only the receiving worktree, preserves source bytes and records differences separately", async t => {
  const { cwd, dir } = fixture(t), target = path.join(dir, "target"); fs.mkdirSync(target);
  fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"before"}');
  fs.writeFileSync(path.join(cwd, "yarn.lock"), "lock");
  const environment = await collectEnvironment({ cwd, raw, agent: "claude" });
  fs.writeFileSync(path.join(target, "package.json"), '{"name":"after"}');
  const normalized = { extensions: { [ENVIRONMENT_EXTENSION]: environment }, session: { messages: [], turns: [] } };
  writeHandoff(target, { meta: { id: "context", revision: { id: "revision" } }, normalized }, "http://localhost");
  const handoff = path.join(target, ".tdsp/context"), snapshotBefore = fs.readFileSync(path.join(handoff, "normalized.json"));
  const sourceBefore = fs.readFileSync(path.join(handoff, "environment.json"));
  const reader = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [path.join(handoff, "read.mjs"), ...args], { cwd: dir, encoding: "utf8" }));
  assert.equal(reader("info").environment.status, "recorded");
  assert.equal(reader("info").extensions[ENVIRONMENT_EXTENSION], undefined);
  assert.deepEqual(reader("environment", "skills"), environment.groups.skills);
  const report = reader("check-environment", "dependencies,access");
  assert.equal(report.cwd, fs.realpathSync(target));
  assert.equal(report.revision_id, "revision");
  assert.equal(report.probe_context, "checker_process");
  assert.equal(report.items.find((i: any) => i.id === "package.json").status, "different");
  assert.equal(report.items.find((i: any) => i.id === "yarn.lock").status, "missing");
  assert.equal(report.items.find((i: any) => i.group === "access").status, "unknown");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(handoff, "environment-check.json"), "utf8")), report);
  assert.deepEqual(fs.readFileSync(path.join(handoff, "normalized.json")), snapshotBefore);
  assert.deepEqual(fs.readFileSync(path.join(handoff, "environment.json")), sourceBefore);
});

test("old/unknown manifests remain usable and historical commands or paths never become probes", async t => {
  const { cwd } = fixture(t);
  assert.equal((await checkEnvironment(null, { cwd })).status, "not_recorded");
  assert.equal((await checkEnvironment({ schema_version: "junction.environment/2" }, { cwd })).status, "unsupported");
  const manifest = emptyEnvironment("/source/device");
  manifest.groups.runtimes.items.push({ id: "node; touch HACKED", observed: { status: "present", value: { command: "touch HACKED" } } });
  manifest.groups.dependencies.items.push({ id: "../secret", observed: { status: "present", value: { path: "/etc/passwd" } } });
  manifest.groups.services.coverage = "not_applicable";
  const report = await checkEnvironment(manifest, { cwd, groups: ["runtimes", "dependencies", "services"] });
  assert.deepEqual(report.items.map((i: any) => i.status).sort(), ["not_applicable", "unknown", "unknown"]);
  assert.equal(fs.existsSync(path.join(cwd, "HACKED")), false);
  await assert.rejects(checkEnvironment(manifest, { cwd, groups: ["../evil"] }), /Unknown environment group/);
});
