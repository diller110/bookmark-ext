import { test } from "node:test";
import assert from "node:assert/strict";
import { scanTabMedia, hostPattern, downloadFrameBlob, readFrameBlob } from "../src/media-scan.js";

test("blob download reports both received bytes and the known file size", async () => {
  const progress = [];
  const file = await downloadFrameBlob(1, {}, {
    onProgress: (_message, bytes) => progress.push(bytes),
    readChunk: async (offset, remove) => remove ? [] : [{ result: { size: 2, type: "video/mp4", chunk: offset ? "Ag==" : "AQ==" } }]
  });
  assert.equal(file.size, 2);
  assert.deepEqual(progress, [
    { loadedBytes: 1, totalBytes: 2, totalApproximate: false },
    { loadedBytes: 2, totalBytes: 2, totalApproximate: false }
  ]);
});

test("blob reader carries frame errors as data rather than losing them at the script boundary", async () => {
  const previous = { fetch: globalThis.fetch, location: globalThis.location };
  globalThis.location = { href: "https://page.test/player" };
  globalThis.fetch = async () => { throw new Error("Источник видео больше недоступен"); };
  try {
    const result = await readFrameBlob("blob:https://page.test/video", location.href, "failed-read", 0);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { error: "Источник видео больше недоступен" });
    await assert.rejects(downloadFrameBlob(1, {}, { readChunk: async () => [{ result }] }), /Источник видео больше недоступен/);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.location === undefined) delete globalThis.location; else globalThis.location = previous.location;
  }
});

test("empty script results report an unavailable frame, including in later chunks", async () => {
  for (const response of [[{ result: null }], [], [{ result: undefined }]]) {
    await assert.rejects(downloadFrameBlob(1, {}, { readChunk: async () => response }), /Фрейм не вернул данные видео/);
  }
  let calls = 0;
  await assert.rejects(downloadFrameBlob(1, {}, { readChunk: async (_offset, remove) => {
    if (remove) return [];
    return [{ result: calls++ ? null : { size: 2, chunk: "AA==", type: "video/mp4" } }];
  } }), /Фрейм не вернул данные видео/);
});

test("blob preview refuses files above its limit and releases the frame cache", async () => {
  const calls = [];
  await assert.rejects(downloadFrameBlob(1, { url: "blob:https://page.test/video" }, {
    byteLimit: 64 * 1024 * 1024,
    readChunk: async (offset, remove) => {
      calls.push({ offset, remove });
      return [{ result: { size: 65 * 1024 * 1024, type: "video/webm", chunk: "AA==" } }];
    }
  }), /64 МБ/);
  assert.deepEqual(calls, [{ offset: 0, remove: undefined }, { offset: 0, remove: true }]);
});

test("frame discovery asks for foreign origins and prefers videos over the largest image", async () => {
  const previous = globalThis.chrome;
  let allowed = false;
  const scanned = [];
  const tab = { id: 1, url: "https://page.test/article" };
  const frames = [{ frameId: 0, url: tab.url }, { frameId: 1, parentFrameId: 0, url: "https://player.test/embed" }, { frameId: 2, parentFrameId: 1, url: "about:srcdoc" }];
  globalThis.chrome = {
    webNavigation: { getAllFrames: async () => frames },
    permissions: { contains: async () => allowed },
    scripting: { executeScript: async ({ target, args }) => {
      const id = target.frameIds[0]; scanned.push(id); assert.equal(args[0], frames[id].url);
      return [{ result: id ? [{ kind: "video", url: "https://cdn.test/video.mp4" }] : [{ kind: "image", url: "https://page.test/photo.jpg", width: 2000, height: 1000 }] }];
    } }
  };
  try {
    let result = await scanTabMedia(tab);
    assert.deepEqual(result.missing, ["https://player.test/*"]);
    assert.deepEqual(scanned, [0]);
    assert.equal(result.candidates[0].kind, "image");
    allowed = true; scanned.length = 0;
    result = await scanTabMedia(tab);
    assert.deepEqual(scanned, [0, 1, 2]);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].kind, "video");
    assert.equal(result.candidates[0].frameId, 1);
    assert.equal(result.candidates[0].origin, "https://player.test");
    assert.deepEqual(result.missing, []);
    chrome.scripting.executeScript = async () => { throw new Error("Frame navigated"); };
    result = await scanTabMedia(tab);
    assert.equal(result.failures.length, 3);
    assert.deepEqual(result.candidates, []);
    assert.equal(hostPattern("https://player.test:443/path"), "https://player.test/*");
    assert.throws(() => hostPattern("file:///C:/secret"), /Недопустимый/);
  } finally { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; }
});
