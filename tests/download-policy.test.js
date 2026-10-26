import test from "node:test";
import assert from "node:assert/strict";
import { assertDownloadSource, assertDownloadJob } from "../src/download-policy.js";
import { fetchMedia } from "../src/media-fetch.js";

test("YouTube remains preview-only across page, frame, media URL and redirects", async () => {
  for (const value of ["https://www.youtube.com/watch?v=testVideo01", "https://youtu.be/testVideo01", "https://r1.googlevideo.com/video", "https://r1.googlevideo.com./video", "blob:https://www.youtube.com/id", "https://www.youtube-nocookie.com/embed/testVideo01"]) {
    assert.throws(() => assertDownloadSource(value), /только встроенное превью/);
  }
  assert.doesNotThrow(() => assertDownloadSource("https://youtube.com.example.test/video.mp4"));
  assert.throws(() => assertDownloadJob({ url: "https://page.test", candidate: { frameUrl: "https://www.youtube.com/embed/testVideo01" } }), /YouTube/);
  const previous = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => ({ url: "https://r1.googlevideo.com/video", body: { cancel: async () => { cancelled = true; } } });
  try {
    await assert.rejects(fetchMedia("https://media.test/redirect"), /YouTube/);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = previous; }
});
