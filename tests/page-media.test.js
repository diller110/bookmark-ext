import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPageMedia, pageMediaCandidates, fetchPageMedia, mediaUrl } from "../src/page-media.js";

test("page scan prefers videos, deduplicates sources, then selects one largest image", () => {
  const previous = globalThis.document;
  const video = (src, sources = []) => ({ currentSrc: src, src: "", poster: "https://media.test/poster.jpg", videoWidth: 1920, videoHeight: 1080, querySelectorAll: () => sources });
  let videos = [video("https://media.test/a.mp4"), video("https://media.test/a.mp4"), video("blob:stream", [{ src: "https://media.test/b.webm", type: "video/webm" }])];
  globalThis.document = { querySelectorAll: () => videos, images: [
    { src: "https://images.test/logo.png", naturalWidth: 100, naturalHeight: 100 },
    { src: "https://images.test/small.jpg", currentSrc: "https://images.test/large.jpg", naturalWidth: 2000, naturalHeight: 1000 },
    { src: "https://images.test/other.jpg", naturalWidth: 600, naturalHeight: 900 }
  ] };
  try {
    assert.deepEqual(collectPageMedia().map(item => item.url), ["https://media.test/a.mp4", "https://media.test/b.webm"]);
    videos = [];
    assert.deepEqual(collectPageMedia().map(item => item.url), ["https://images.test/large.jpg"]);
    document.images = [];
    assert.deepEqual(collectPageMedia(), []);
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test("untrusted media URLs are rejected and stream transports are identified", () => {
  for (const url of ["javascript:alert(1)", "file:///C:/secret", "chrome://settings", "data:text/html,<script>", "https://user:secret@example.com/a"]) assert.equal(mediaUrl(url, true), null);
  assert.equal(mediaUrl("data:image/png;base64,AA==", true), "data:image/png;base64,AA==");
  const items = pageMediaCandidates([
    { kind: "video", url: "blob:https://example.com/a" },
    { kind: "video", url: "https://example.com/list.m3u8" },
    { kind: "video", url: "https://example.com/stream", type: "application/dash+xml" },
    { kind: "video", url: "https://example.com/video.mp4", width: -1, height: "100" },
    { kind: "image", url: "https://example.com/image.jpg", poster: "javascript:alert(1)" },
    { kind: "iframe", url: "https://example.com/" }
  ]);
  assert.deepEqual(items.map(item => item.downloadable), [false, true, true, true, true]);
  assert.deepEqual(items.map(item => item.transport), ["file", "hls", "dash", "file", "file"]);
  const blob = pageMediaCandidates([{ kind: "video", url: "blob:https://example.com/a" }], { frameId: 2, origin: "https://example.com", frameUrl: "https://example.com/frame" })[0];
  assert.equal(blob.transport, "blob");
  assert.equal(blob.downloadable, true);
  assert.equal(items[3].width, 0);
  assert.equal(items[3].height, 0);
  assert.equal(items[4].poster, null);
  assert.throws(() => pageMediaCandidates(null), /некорректный/);
});

test("page scan orders videos and selects images by their rendered area rather than source resolution", () => {
  const previous = globalThis.document;
  const video = (url, width, height) => ({ src: url, videoWidth: 3840, videoHeight: 2160, querySelectorAll: () => [], getBoundingClientRect: () => ({ width, height }) });
  let videos = [video("https://page.test/small.mp4", 100, 100), video("https://page.test/large.mp4", 800, 600), video("https://page.test/small.mp4", 900, 600)];
  globalThis.document = { querySelectorAll: () => videos, images: [
    { src: "https://page.test/hires.jpg", naturalWidth: 8000, naturalHeight: 8000, getBoundingClientRect: () => ({ width: 50, height: 50 }) },
    { src: "https://page.test/visible.jpg", naturalWidth: 800, naturalHeight: 600, getBoundingClientRect: () => ({ width: 800, height: 600 }) }
  ] };
  try {
    assert.deepEqual(collectPageMedia().map(item => [item.url, item.pageArea]), [["https://page.test/small.mp4", 540000], ["https://page.test/large.mp4", 480000]]);
    videos = [];
    assert.equal(collectPageMedia()[0].url, "https://page.test/visible.jpg");
    assert.equal(pageMediaCandidates([{ kind: "video", pageArea: -1 }])[0].pageArea, 0);
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test("MediaSource video uses manifest URLs from resource timing while direct video ignores old streams", () => {
  const previous = { document: globalThis.document, performance: globalThis.performance };
  const video = { src: "blob:https://page.test/video", currentSrc: "", poster: "", querySelectorAll: () => [] };
  globalThis.document = { querySelectorAll: () => [video], images: [] };
  globalThis.performance = { getEntriesByType: () => [{ name: "https://cdn.test/master.m3u8" }, { name: "https://cdn.test/master.m3u8" }, { name: "https://cdn.test/seg.ts" }] };
  try {
    assert.deepEqual(collectPageMedia().map(item => item.url), ["https://cdn.test/master.m3u8"]);
    video.src = "https://cdn.test/direct.mp4";
    assert.deepEqual(collectPageMedia().map(item => item.url), ["https://cdn.test/direct.mp4"]);
  } finally {
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    globalThis.performance = previous.performance;
  }
});

test("media download validates HTTP, media type and empty responses before creating a resource File", async () => {
  const original = globalThis.fetch;
  const candidate = pageMediaCandidates([{ kind: "image", url: "https://example.com/photo.png" }])[0];
  try {
    globalThis.fetch = async () => new Response("pixels", { headers: { "Content-Type": "image/png" } });
    const file = await fetchPageMedia(candidate);
    assert.equal(file.name, "photo.png");
    assert.equal(file.type, "image/png");
    assert.equal(await file.text(), "pixels");
    const progress = [];
    const bytes = [];
    globalThis.fetch = async () => new Response("pixels", { headers: { "Content-Type": "image/png", "Content-Length": "6" } });
    assert.equal(await (await fetchPageMedia(candidate, { onProgress: (message, size) => { progress.push(message); bytes.push(size); } })).text(), "pixels");
    assert.deepEqual(progress, ["Загружено: 100 %"]);
    assert.deepEqual(bytes.at(-1), { loadedBytes: 6, totalBytes: 6, totalApproximate: false });
    globalThis.fetch = async () => new Response("jpeg", { headers: { "Content-Type": "image/jpeg" } });
    assert.equal((await fetchPageMedia({ ...candidate, url: "https://example.com/photo.jpeg" })).name, "photo.jpeg");
    globalThis.fetch = async () => new Response("login", { headers: { "Content-Type": "text/html" } });
    await assert.rejects(fetchPageMedia(candidate), /другой тип/);
    globalThis.fetch = async () => new Response("", { status: 403 });
    await assert.rejects(fetchPageMedia(candidate), /403/);
    globalThis.fetch = async () => new Response("", { headers: { "Content-Type": "image/png" } });
    await assert.rejects(fetchPageMedia(candidate), /пустой/);
    globalThis.fetch = async () => new Response("video", { headers: { "Content-Type": "application/octet-stream" } });
    const video = await fetchPageMedia(pageMediaCandidates([{ kind: "video", url: "https://example.com/clip.mp4" }])[0]);
    assert.equal(video.type, "video/mp4");
    globalThis.fetch = async () => new Response("document", { headers: { "Content-Type": "application/pdf" } });
    const document = await fetchPageMedia({ downloadable: true, kind: "file", url: "https://example.com/report.pdf", type: "" });
    assert.equal(document.name, "report.pdf");
    assert.equal(document.type, "application/pdf");
    assert.equal(await document.text(), "document");
    globalThis.fetch = async () => new Response(new Uint8Array([0, 1, 2]), { headers: { "Content-Type": "application/octet-stream" } });
    assert.equal((await fetchPageMedia({ downloadable: true, kind: "file", url: "https://example.com/archive.bin", type: "" })).type, "application/octet-stream");
    await assert.rejects(fetchPageMedia({ downloadable: false }), /прямой ссылки/);
  } finally { globalThis.fetch = original; }
});
test("direct media bounds declared and chunked bodies even without a progress listener", async () => {
  const original = globalThis.fetch;
  const candidate = { downloadable: true, kind: "file", url: "https://example.com/file.bin", type: "" };
  let cancelled = false;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); },
      cancel() { cancelled = true; }
    }));
    await assert.rejects(fetchPageMedia(candidate, { byteLimit: 4 }), /превышает лимит/);
    assert.equal(cancelled, true);
    globalThis.fetch = async () => new Response("small", { headers: { "Content-Length": "1000" } });
    await assert.rejects(fetchPageMedia(candidate, { byteLimit: 4 }), /превышает лимит/);
    globalThis.fetch = async () => new Response(new Uint8Array(4));
    assert.equal((await fetchPageMedia(candidate, { byteLimit: 4 })).size, 4);
  } finally { globalThis.fetch = original; }
});
