import { test } from "node:test";
import assert from "node:assert/strict";
import { planStream, segmentIv, MediaPermissionsRequired } from "../src/stream-download.js";

test("stream preview plans only the first 30 seconds while normal download keeps every segment", async () => {
  const original = globalThis.fetch;
  const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:5\n" + Array.from({ length: 50 }, (_, index) => `#EXTINF:5,\nsegment-${index}.ts`).join("\n") + "\n#EXT-X-ENDLIST";
  globalThis.fetch = async () => new Response(playlist);
  try {
    const candidate = { url: "https://media.test/playlist.m3u8", transport: "hls" };
    const preview = await planStream(candidate, { preview: true });
    assert.equal(preview.tracks[0].playlist.segments.length, 6);
    assert.equal(preview.tracks[0].playlist.segments.at(-1).uri, "segment-5.ts");
    const complete = await planStream(candidate);
    assert.equal(complete.tracks[0].playlist.segments.length, 50);
  } finally { globalThis.fetch = original; }
});

test("HLS planning selects the best rendition plus default audio and resolves relative segment resources", async () => {
  const original = globalThis.fetch;
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\none.m4s\n#EXT-X-ENDLIST';
  const fixtures = new Map([
    ["https://media.test/master.m3u8", '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",DEFAULT=YES,URI="sound.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200,AUDIO="audio"\nhigh/video.m3u8'],
    ["https://media.test/high/video.m3u8", media.replace('URI="../key.bin"', 'URI="../key.bin",IV=0x00000000000000000000000000000001')],
    ["https://media.test/sound.m3u8", '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsound.ts\n#EXT-X-ENDLIST']
  ]);
  globalThis.fetch = async url => { assert.ok(fixtures.has(url), `Unexpected request ${url}`); return new Response(fixtures.get(url)); };
  try {
    const plan = await planStream({ url: "https://media.test/master.m3u8", transport: "hls" });
    assert.equal(plan.tracks.length, 2);
    assert.equal(plan.tracks[0].base, "https://media.test/high/video.m3u8");
    assert.equal(plan.tracks[0].playlist.segments[0].map.uri, "init.mp4");
    assert.equal(plan.live, false);
    fixtures.set("https://media.test/high/video.m3u8", media);
    await assert.rejects(planStream({ url: "https://media.test/master.m3u8", transport: "hls" }), /не содержит IV/);
    fixtures.set("https://media.test/high/video.m3u8", media.replace('METHOD=AES-128', 'METHOD=SAMPLE-AES'));
    await assert.rejects(planStream({ url: "https://media.test/master.m3u8", transport: "hls" }), /DRM/);
  } finally { globalThis.fetch = original; }
});

test("HLS byte ranges, live snapshots, invalid references and missing CDN permissions are explicit", async () => {
  const original = { fetch: globalThis.fetch, chrome: globalThis.chrome };
  let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n#EXT-X-BYTERANGE:100@0\nclip.ts\n#EXTINF:2,\n#EXT-X-BYTERANGE:200\nclip.ts';
  globalThis.fetch = async () => new Response(playlist);
  try {
    const candidate = { url: "https://media.test/list.m3u8", transport: "hls" };
    const plan = await planStream(candidate);
    assert.equal(plan.live, true);
    assert.deepEqual(plan.tracks[0].playlist.segments.map(segment => segment.byterange), [{ length: 100, offset: 0 }, { length: 200, offset: 100 }]);
    playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlist.m3u8';
    await assert.rejects(planStream(candidate), /Зацикленный/);
    playlist = '#EXTM3U\n#EXTINF:2,\nfile:///C:/secret';
    await assert.rejects(planStream(candidate), /недопустимый/);
    playlist = '#EXTM3U\n#EXTINF:2,\nhttps://cdn.test/a.ts';
    globalThis.chrome = { permissions: { contains: async ({ origins }) => origins.every(origin => !origin.includes("cdn.test")) } };
    await assert.rejects(planStream(candidate), error => error instanceof MediaPermissionsRequired && error.origins[0] === "https://cdn.test/*");
  } finally { globalThis.fetch = original.fetch; if (original.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = original.chrome; }
});

test("AES-128 IVs preserve explicit words and full sequence numbers", () => {
  assert.deepEqual([...segmentIv([0, 0, 0, 0x01020304], 0)].slice(12), [1, 2, 3, 4]);
  assert.deepEqual([...segmentIv(null, 0x100000001)].slice(8), [0, 0, 0, 1, 0, 0, 0, 1]);
  assert.throws(() => segmentIv([1], 0), /IV/);
  assert.throws(() => segmentIv(null, -1), /номер/);
});
