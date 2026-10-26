import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CORE_URL, localAssetURL } from "../vendor/streaming/const.js";
import { FFmpeg } from "../vendor/streaming/classes.js";

test("FFmpeg only accepts the exact bundled executable assets", () => {
  for (const name of ["./worker.js", "./ffmpeg-core.js", "./ffmpeg-core.wasm"]) {
    const expected = new URL(`../vendor/streaming/${name.slice(2)}`, import.meta.url).href;
    assert.equal(localAssetURL(undefined, name), expected);
    assert.equal(localAssetURL(expected, name), expected);
    for (const value of ["https://cdn.test/core.js", "data:text/javascript,1", "blob:https://example.test/id", "./other.js", `${expected}?remote=1`, `${expected}#remote`])
      assert.throws(() => localAssetURL(value, name), /bundled/);
  }
  assert.equal(CORE_URL, localAssetURL(undefined, "./ffmpeg-core.js"));
  assert.throws(() => new FFmpeg().load({ classWorkerURL: "https://cdn.test/worker.js" }), /bundled/);
});

test("FFmpeg worker rejects alternate core, WASM and nested-worker URLs before loading", async () => {
  const previous = globalThis.self;
  const replies = [];
  globalThis.self = { postMessage: reply => replies.push(reply) };
  try {
    await import("../vendor/streaming/worker.js");
    for (const config of [{ coreURL: "https://cdn.test/core.js" }, { wasmURL: "https://cdn.test/core.wasm" }, { workerURL: "https://cdn.test/nested.js" }]) {
      await self.onmessage({ data: { id: replies.length, type: "LOAD", data: config } });
      assert.equal(replies.at(-1).type, "ERROR");
      assert.match(replies.at(-1).data, /bundled|single-threaded/);
    }
    const source = await readFile(new URL("../vendor/streaming/worker.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /importScripts|await import\(|https?:\/\//);
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
});
