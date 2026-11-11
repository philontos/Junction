import test from "node:test";
import assert from "node:assert/strict";
import { readShareStream } from "./junction-stream.js";

function response(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  }), { headers: { "content-type": "application/x-ndjson" } });
}
test("sharing reads split UTF-8 progress and requires a completed receipt", async () => {
  const progress = [];
  const result = await readShareStream(response(
    JSON.stringify({ type: "progress", message: "正在整理 🧩" }) + "\n" +
    JSON.stringify({ type: "complete", result: { id: "revision", context_id: "context" } }) + "\n", 1
  ), event => progress.push(event.message));
  assert.deepEqual(progress, ["正在整理 🧩"]);
  assert.equal(result.id, "revision");
});
test("interrupted sharing never reports success from HTTP 200", async () => {
  await assert.rejects(readShareStream(response('{"type":"progress","message":"上传中"}\n'), () => {}), /尚未收到/);
  await assert.rejects(readShareStream(response('{"type":"error","message":"找不到会话"}\n'), () => {}), /找不到会话/);
  await assert.rejects(readShareStream(response('{"type":"complete","result":{}}\n'), () => {}), /回执无效/);
});
