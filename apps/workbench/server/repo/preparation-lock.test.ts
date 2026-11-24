import { test } from "node:test";
import assert from "node:assert/strict";
import { withMirrorPreparation } from "./preparation-lock.js";

test("same-mirror jobs wait for cache publication; cancellation cannot let later jobs bypass the lock", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered: number[] = [];
  const first = withMirrorPreparation("repo", undefined, async () => { entered.push(1); await gate; });
  const controller = new AbortController();
  const second = withMirrorPreparation("repo", controller.signal, async () => { entered.push(2); });
  const rejected = assert.rejects(second, (error: any) => error.name === "AbortError");
  controller.abort();
  await rejected;
  const third = withMirrorPreparation("repo", undefined, async () => { entered.push(3); });
  await withMirrorPreparation("another-repo", undefined, async () => { entered.push(4); });
  assert.deepEqual(entered, [1, 4]);
  release(); await Promise.all([first, third]);
  assert.deepEqual(entered, [1, 4, 3]);
});
