import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchMedia } from "../src/media-fetch.js";
import { readMediaSize } from "../src/media-size.js";

test("public media and size probes omit credentials so wildcard CDN CORS can succeed", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(options);
    return new Response("video", { headers: { "Content-Type": "video/mp4", "Content-Length": "5", "Access-Control-Allow-Origin": "*" } });
  };
  try {
    assert.equal(await (await fetchMedia("https://cdn.test/video.mp4")).text(), "video");
    assert.equal(await readMediaSize("https://cdn.test/video.mp4"), 5);
    assert.deepEqual(calls.map(call => call.credentials), ["omit", "omit"]);
  } finally { globalThis.fetch = previous; }
});

test("media retries authentication failures with cookies while preserving range headers and cancellation", async () => {
  const previous = globalThis.fetch;
  try {
    for (const failure of [401, 403, "html", "network"]) {
      const calls = [];
      globalThis.fetch = async (_url, options) => {
        calls.push(options);
        if (calls.length === 1) {
          if (failure === "network") throw new TypeError("Failed to fetch");
          return failure === "html" ? new Response("Login", { headers: { "Content-Type": "text/html" } }) : new Response("Denied", { status: failure });
        }
        return new Response("video", { headers: { "Content-Type": "video/mp4", "Content-Length": "5" } });
      };
      const signal = new AbortController().signal;
      assert.equal(await (await fetchMedia("https://private.test/video", { signal, headers: { Range: "bytes=0-4" } })).text(), "video");
      assert.deepEqual(calls.map(call => call.credentials), ["omit", "include"]);
      assert.ok(calls.every(call => call.signal === signal && call.headers.Range === "bytes=0-4"));
      calls.length = 0;
      assert.equal(await readMediaSize("https://private.test/video"), 5);
      assert.deepEqual(calls.map(call => call.credentials), ["omit", "include"]);
    }
  } finally { globalThis.fetch = previous; }
});

test("media does not retry cancelled downloads or unrelated HTTP failures", async () => {
  const previous = globalThis.fetch;
  try {
    let calls = 0;
    const controller = new AbortController();
    globalThis.fetch = async () => { calls++; controller.abort(); throw new TypeError("Cancelled"); };
    await assert.rejects(fetchMedia("https://cdn.test/video", { signal: controller.signal }), /Cancelled/);
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("Unavailable", { status: 503 }); };
    assert.equal((await fetchMedia("https://cdn.test/video")).status, 503);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});
