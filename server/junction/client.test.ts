import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JunctionClient, readConfig, revisionPath } from "./client.js";
import { handoffPrompt, repoIdentity, publicRepoUrl, writeHandoff, WORKSPACE_EXTENSION } from "./handoff.js";
const cid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", rid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junction-test-"));
  const token = path.join(dir, "token"); fs.writeFileSync(token, "secret-for-test");
  const config = { url: "http://127.0.0.1:8767", default_account: "owner", accounts: [{ id: "owner", label: "Owner", token_file: token }] };
  return { dir, config };
}
test("snapshot follows all pages and content chunks with the selected credential, never redirects", async () => {
  const { dir, config } = fixture();
  const content = JSON.stringify([{ kind: "text", text: "完整的上下文 🧩" }]);
  const calls: string[] = [];
  const meta = { id: cid, revision: { id: rid, message_count: 2, turn_count: 1, normalized: { schema_version: "junction.context/1", session: {}, extensions: {} } } };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    assert.equal((init?.headers as any).Authorization, "Bearer secret-for-test"); assert.equal(init?.redirect, "error");
    let value: any;
    if (url.pathname.endsWith(rid)) value = meta;
    else if (url.pathname.endsWith("/turns")) value = { items: [{ id: "t1" }], next_cursor: null };
    else if (url.pathname.endsWith("/diagnostics")) value = { items: [], next_cursor: null };
    else if (url.pathname.endsWith("/messages")) value = url.searchParams.has("cursor")
      ? { items: [{ id: "m2", content: [], content_truncated: false }], next_cursor: null }
      : { items: [{ id: "m1", content: null, content_truncated: true }], next_cursor: "next" };
    else { const offset = Number(url.searchParams.get("offset")); value = { text: content.slice(offset, offset + 10), next_offset: offset + 10 < content.length ? offset + 10 : null }; }
    return new Response(JSON.stringify(value));
  };
  try {
    const snapshot = await new JunctionClient(config, "owner", fetcher).snapshot(cid, rid);
    assert.equal(snapshot.normalized.session.messages[0].content[0].text, "完整的上下文 🧩");
    assert.equal(snapshot.normalized.session.messages.length, 2);
    assert.equal(snapshot.normalized.session.messages[0].content_truncated, undefined);
    assert.ok(calls.some(p => p.includes("cursor=next")));
    assert.equal((meta.revision.normalized.session as any).messages, undefined);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test("bad account and resource references fail before accessing credentials", () => {
  const { dir, config } = fixture();
  try {
    assert.throws(() => new JunctionClient(config, "../../token"), /未知/);
    assert.throws(() => revisionPath("../me", rid), /无效/);
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ ...config, url: "http://secret@localhost" }));
    assert.throws(() => readConfig(file), /凭据/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test("snapshot retains the native record index and rejects an incomplete download", async () => {
  const { dir, config } = fixture();
  let expected = 2;
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    let value: any;
    if (url.pathname.endsWith(rid)) value = { id: cid, revision: { id: rid, message_count: 0, turn_count: 0,
      normalized: { schema_version: "junction.context/1", session: {}, record_index: { indexed_records: expected, complete: true } } } };
    else if (url.pathname.endsWith("/records")) value = url.searchParams.has("cursor")
      ? { items: [{ id: "r2", status: "unmapped" }], next_cursor: null }
      : { items: [{ id: "r1", status: "invalid" }], next_cursor: "next" };
    else value = { items: [], next_cursor: null };
    return new Response(JSON.stringify(value));
  };
  try {
    const client = new JunctionClient(config, "owner", fetcher);
    const snapshot = await client.snapshot(cid, rid);
    assert.deepEqual(snapshot.normalized.records.map((r: any) => r.id), ["r1", "r2"]);
    assert.ok(calls.every(p => !p.endsWith("/raw") && !p.endsWith("/content")));
    expected = 3;
    await assert.rejects(client.snapshot(cid, rid), /索引下载不完整/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test("grant revocation during export aborts instead of producing a partial context", async () => {
  const { dir, config } = fixture();
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: { detail: "Not found" } }), { status: 404 });
  try { await assert.rejects(new JunctionClient(config, "owner", fetcher).snapshot(cid, rid), /Not found/); }
  finally { fs.rmSync(dir, { recursive: true }); }
});
test("handoff preserves provenance and full history, with a working paginated offline reader", () => {
  const { dir } = fixture();
  const workspace = { repo_url: "git@github.com:org/repo.git", branch: "feature", commit: "a".repeat(40), dirty: true };
  const overview = { title: "Recorded task", description: "An excerpt with evidence", missing: [{ field: "cwd" }] };
  const normalized = { schema_version: "junction.context/1", extensions: { [WORKSPACE_EXTENSION]: workspace, "junction.overview/1": overview }, diagnostics: [], records: [{ id: "r1", status: "projected", message_ids: ["m1"] }],
    session: { turns: [{ id: "t1" }], messages: [{ id: "m1", role: "user", content: [{ kind: "text", text: "x".repeat(4000) }] }] } };
  try {
    writeHandoff(dir, { meta: { id: cid, revision: { id: rid, source_sha256: "sha" } }, normalized }, "http://localhost:8767");
    const reader = path.join(dir, ".tdsp/context/read.mjs");
    const info = JSON.parse(execFileSync(process.execPath, [reader, "info"], { encoding: "utf8" }));
    assert.deepEqual(info.extensions["junction.overview/1"], overview);
    assert.equal(info.records, undefined);
    const records = JSON.parse(execFileSync(process.execPath, [reader, "records", "0", "1"], { encoding: "utf8" }));
    assert.deepEqual(records.items, normalized.records);
    const record = JSON.parse(execFileSync(process.execPath, [reader, "record", "r1"], { encoding: "utf8" }));
    assert.deepEqual(record, normalized.records[0]);
    const page = JSON.parse(execFileSync(process.execPath, [reader, "messages", "0", "1"], { encoding: "utf8" }));
    assert.equal(page.next_offset, null); assert.equal(page.items[0].content, undefined);
    const full = JSON.parse(execFileSync(process.execPath, [reader, "message", "m1"], { encoding: "utf8" }));
    assert.equal(full.content[0].text.length, 4000);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".tdsp/context/manifest.json"), "utf8"));
    assert.equal(manifest.revision_id, rid); assert.equal(manifest.workspace.dirty, true);
    assert.equal(fs.statSync(path.join(dir, ".tdsp/context/normalized.json")).mode & 0o777, 0o600);
    assert.match(handoffPrompt(), /SKILL.md/);
    assert.throws(() => writeHandoff(dir, { meta: { revision: {} }, normalized }, "url"), /EEXIST/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test("repository URLs strip credentials and match SSH to HTTPS without equating unrelated repos", () => {
  assert.equal(publicRepoUrl("https://secret:token@github.com/org/repo.git?q=token"), "https://github.com/org/repo.git");
  assert.equal(repoIdentity("git@github.com:org/repo.git"), repoIdentity("https://github.com/org/repo"));
  assert.notEqual(repoIdentity("/local/a"), repoIdentity("/local/b"));
});
