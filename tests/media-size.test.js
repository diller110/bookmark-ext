import { test } from "node:test";
import assert from "node:assert/strict";
import { readMediaSize, mediaSize, mediaSizeLabel, downloadSizeLabel } from "../src/media-size.js";

test("queue size labels distinguish exact, estimated and unknown totals, including older jobs", () => {
  assert.equal(downloadSizeLabel({ loadedBytes: 1024, totalBytes: 2048 }), "1 КБ / 2 КБ");
  assert.equal(downloadSizeLabel({ loadedBytes: 1024, totalBytes: 2048, totalApproximate: true }), "1 КБ / ≈ 2 КБ");
  assert.equal(downloadSizeLabel({ loadedBytes: 1024 }), "1 КБ / размер неизвестен");
  assert.equal(downloadSizeLabel({}), "0 Б / размер неизвестен");
});

test("size probes use headers only and reject unknown, compressed, partial or error lengths", async () => {
  const original = globalThis.fetch;
  try {
    for (const [headers, status, expected] of [
      [{ "Content-Length": "2048" }, 200, 2048],
      [{ "Content-Length": "20", "Content-Range": "bytes 0-19/4000" }, 206, 4000],
      [{ "Content-Length": "20" }, 206, null],
      [{ "Content-Length": "200", "Content-Encoding": "gzip" }, 200, null],
      [{ "Content-Length": "200", "Content-Type": "text/html" }, 200, null],
      [{ "Content-Length": "-1" }, 200, null],
      [{}, 200, null], [{ "Content-Length": "100" }, 403, null]
    ]) {
      globalThis.fetch = async (_url, options) => {
        assert.equal(options.method, "HEAD");
        const response = new Response(null, { status, headers });
        response.blob = () => assert.fail("Must not download the file to measure its size");
        return response;
      };
      assert.equal(await readMediaSize("https://media.test/a.mp4"), expected);
    }
    globalThis.fetch = async () => { throw new Error("Unavailable"); };
    assert.equal(await readMediaSize("https://media.test/a.mp4"), null);
  } finally { globalThis.fetch = original; }
});

test("HLS size estimates sample segments, include audio and mark live windows", async () => {
  const original = globalThis.fetch;
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200,AUDIO="audio"\nvideo.m3u8';
  const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n" + Array.from({ length: 10 }, (_, index) => `#EXTINF:2,\n${index}.ts\n`).join("");
  let probes = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === "HEAD") { probes++; return new Response(null, { headers: { "Content-Length": "1000" } }); }
    return new Response(url.endsWith("master.m3u8") ? master : playlist);
  };
  try {
    const size = await mediaSize({ transport: "hls", url: "https://media.test/master.m3u8" }, 7, new AbortController().signal);
    assert.deepEqual(size, { bytes: 20000, approximate: true, live: true });
    assert.equal(probes, 6);
    assert.match(mediaSizeLabel(size), /^≈ .*КБ · доступный фрагмент$/);
    assert.equal(mediaSizeLabel({ bytes: 1024 ** 2, approximate: false }), "1 МБ");
    assert.equal(mediaSizeLabel(null), "Размер неизвестен");
    assert.equal(await mediaSize({ transport: "blob", url: "blob:https://media.test/a" }, 7), null);
  } finally { globalThis.fetch = original; }
});

test("direct media reads headers with granted access or probes the owning iframe without requesting permissions", async () => {
  const original = { fetch: globalThis.fetch, chrome: globalThis.chrome };
  const candidate = { url: "https://media.test/a.mp4", transport: "file", frameId: 2, frameUrl: "https://page.test/player" };
  let granted = true;
  globalThis.chrome = {
    permissions: { contains: async () => granted },
    scripting: { executeScript: async ({ target, func, args }) => {
      assert.deepEqual(target, { tabId: 7, frameIds: [2] });
      assert.equal(func, readMediaSize);
      assert.deepEqual(args, [candidate.url, candidate.frameUrl]);
      return [{ result: 512 }];
    } }
  };
  globalThis.fetch = async () => new Response(null, { headers: { "Content-Length": "1024" } });
  try {
    const signal = new AbortController().signal;
    assert.deepEqual(await mediaSize(candidate, 7, signal), { bytes: 1024, approximate: false });
    granted = false;
    assert.deepEqual(await mediaSize(candidate, 7, signal), { bytes: 512, approximate: false });
  } finally { globalThis.fetch = original.fetch; if (original.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = original.chrome; }
});
