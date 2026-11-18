import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectJunction, connectionInfo } from "./connection.js";
import { JunctionClient, readConfig } from "./client.js";

const token = "device_token_for_local_test_123456", nodeId = "0123abcd";
const identity = { user_id: "alice", device_id: nodeId };
const ok: typeof fetch = async (url, init) => {
  assert.equal(String(url).endsWith("/v1/me"), true);
  assert.equal(init?.redirect, "error");
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + token);
  assert.ok(init?.signal);
  return Response.json(identity);
};
function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junction-connect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "junction.json") };
}

test("connection verifies identity then persists a private credential without returning it", async t => {
  const { dir, file } = fixture(t);
  assert.equal(connectionInfo(file, nodeId).configured, false);
  const result = await connectJunction(file, nodeId, { url: "https://junction.example.com/", token }, ok);
  assert.deepEqual(result, { configured: true, url: "https://junction.example.com", node_id: nodeId, ...identity });
  assert.ok(!JSON.stringify(result).includes(token));
  const config = readConfig(file);
  assert.equal(config.default_account, "device");
  assert.equal(fs.readFileSync(config.accounts[0].token_file, "utf8").trim(), token);
  assert.equal(fs.statSync(config.accounts[0].token_file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, ".junction-credentials")).mode & 0o777, 0o700);
  assert.ok(!fs.readFileSync(file, "utf8").includes(token));
  assert.ok(!JSON.stringify(connectionInfo(file, nodeId)).includes("token"));
});

test("rejected credentials, device mismatches and invalid responses never replace working configuration", async t => {
  const { dir, file } = fixture(t);
  await connectJunction(file, nodeId, { url: "http://127.0.0.1:8767", token }, ok);
  const before = fs.readFileSync(file, "utf8"), files = fs.readdirSync(path.join(dir, ".junction-credentials"));
  const failures: typeof fetch[] = [
    async () => new Response(null, { status: 401 }),
    async () => Response.json({ user_id: "alice", device_id: "other-node" }),
    async () => Response.json({ user_id: "../invalid" }),
    async () => new Response("<html>gateway error</html>"),
    async () => { throw new TypeError("network unavailable"); },
  ];
  for (const fetcher of failures) {
    await assert.rejects(connectJunction(file, nodeId, { url: "https://new.example.com", token }, fetcher), /当前配置未更改/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.join(dir, ".junction-credentials")), files);
  }
});

test("only HTTPS or literal local/private HTTP addresses receive credentials", async t => {
  const { file } = fixture(t);
  const never: typeof fetch = async () => { assert.fail("invalid URL must not receive a credential"); };
  for (const url of ["http://public.example.com", "http://8.8.8.8", "http://169.254.169.254", "https://user:secret@example.com", "https://example.com/path", "https://example.com?q=1", "ftp://localhost"]) {
    await assert.rejects(connectJunction(file, nodeId, { url, token }, never));
  }
  await assert.rejects(connectJunction(file, nodeId, { url: "https://example.com", token: token + "\nbad" }, never));
  assert.equal(fs.existsSync(file), false);
  for (const url of ["http://10.10.0.3:8767", "http://172.16.3.4", "http://192.168.2.4", "http://[::1]:8767"]) {
    await connectJunction(file, nodeId, { url, token }, ok);
    assert.equal(readConfig(file).url, url);
  }
});

test("same-server connection preserves other accounts; switching server does not forward their tokens", async t => {
  const { dir, file } = fixture(t);
  const previous = { url: "http://127.0.0.1:8767", default_account: "reviewer",
    accounts: [{ id: "reviewer", label: "Reviewer", token_file: path.join(dir, "reviewer.token") }] };
  fs.writeFileSync(file, JSON.stringify(previous));
  await connectJunction(file, nodeId, { url: previous.url, token }, ok);
  assert.deepEqual(readConfig(file).accounts[0], previous.accounts[0]);
  const oldCredential = readConfig(file).accounts[1].token_file;
  await connectJunction(file, nodeId, { url: "https://new.example.com", token }, ok);
  assert.equal(readConfig(file).accounts.length, 1);
  assert.equal(fs.existsSync(oldCredential), true); // in-flight requests / manual rollback
  const backups = fs.readdirSync(path.join(dir, ".junction-credentials")).filter(f => f.endsWith(".previous.json"));
  assert.equal(backups.length, 2);
});

test("gateway non-JSON responses have a useful error instead of leaking HTML", async t => {
  const { file } = fixture(t);
  await connectJunction(file, nodeId, { url: "https://junction.example.com", token }, ok);
  const client = new JunctionClient(readConfig(file), undefined, async () => new Response("<html>private gateway detail</html>", { status: 502 }));
  await assert.rejects(client.request("/v1/me"), /HTTP 502/);
});
