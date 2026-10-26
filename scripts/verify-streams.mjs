import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCipheriv } from "node:crypto";
import { pathToFileURL } from "node:url";
import { downloadHarness } from "./download-harness.mjs";
import { collectPageMedia } from "../src/page-media.js";
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url)));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext();
  const assets = new Map();
  const gates = new Map();
  const requested = [];
  await context.route("http://localhost:8123/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/fixture.html") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Stream verification</title>", headers: { "Content-Security-Policy": manifest.content_security_policy.extension_pages } });
    if (pathname === "/source.html") return route.fulfill({ contentType: "text/html", body: '<!doctype html><video src="/media/master.m3u8"></video>' });
    if (pathname.startsWith("/media/")) {
      requested.push(pathname);
      if (gates.has(pathname)) await gates.get(pathname);
      const file = assets.get(pathname.slice(7));
      if (!file) return route.fulfill({ status: 404, body: "Missing fixture" });
      if (pathname.endsWith("slow.m3u8")) await new Promise(resolve => setTimeout(resolve, 5000));
      const range = route.request().headers().range;
      if (range) {
        const [, start, requestedEnd] = /^bytes=(\d+)-(\d*)$/.exec(range);
        const end = requestedEnd || String(file.length - 1);
        return route.fulfill({ status: 206, body: file.subarray(Number(start), Number(end) + 1), headers: { "Content-Range": `bytes ${start}-${end}/${file.length}` } });
      }
      return route.fulfill({ body: file, contentType: pathname.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : pathname.endsWith("mpd") ? "application/dash+xml" : "application/octet-stream" });
    }
    const type = { js: "text/javascript", wasm: "application/wasm", css: "text/css", html: "text/html", svg: "image/svg+xml" }[pathname.split(".").pop()];
    return route.fulfill({ body: await readFile(new URL(`..${pathname}`, import.meta.url)), contentType: type, headers: { "Content-Security-Policy": manifest.content_security_policy.extension_pages } });
  });
  let page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://localhost:8123/fixture.html");
  const fixtures = await page.evaluate(async () => {
    const { FFmpeg } = await import("./vendor/streaming/index.js");
    const ffmpeg = new FFmpeg();
    const logs = [];
    ffmpeg.on("log", ({ message }) => logs.push(message));
    await ffmpeg.load({ coreURL: new URL("./vendor/streaming/ffmpeg-core.js", location.href).href, wasmURL: new URL("./vendor/streaming/ffmpeg-core.wasm", location.href).href });
    const exec = async args => { if (await ffmpeg.exec(args)) throw new Error(logs.slice(-12).join("\n")); };
    await exec(["-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-g", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", "input.mp4"]);
    await exec(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "0.1", "-c:a", "pcm_s16le", "sample.caf"]);
    await exec(["-i", "input.mp4", "-c", "copy", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_filename", "muxed%d.ts", "muxed.m3u8"]);
    await exec(["-i", "input.mp4", "-an", "-c", "copy", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_filename", "video%d.ts", "video.m3u8"]);
    await exec(["-i", "input.mp4", "-vn", "-c", "copy", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_filename", "audio%d.ts", "audio.m3u8"]);
    await exec(["-i", "input.mp4", "-c", "copy", "-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4", "-hls_playlist_type", "vod", "fragmented.m3u8"]);
    await exec(["-i", "input.mp4", "-c", "copy", "-f", "dash", "-seg_duration", "1", "manifest.mpd"]);
    await exec(["-i", "input.mp4", "-c", "copy", "-f", "dash", "-seg_duration", "1", "-use_template", "0", "-use_timeline", "0", "-init_seg_name", "list-init-$RepresentationID$.mp4", "-media_seg_name", "list-chunk-$RepresentationID$-$Number%05d$.m4s", "list.mpd"]);
    const files = [];
    for (const entry of await ffmpeg.listDir("/")) {
      if (!entry.isDir) files.push([entry.name, [...await ffmpeg.readFile(entry.name)]]);
    }
    ffmpeg.terminate();
    return files;
  });
  for (const [name, data] of fixtures) assets.set(name, Buffer.from(data));
  console.log(`Generated ${assets.size} real audio/video fixtures with the bundled FFmpeg.`);
  const muxed = assets.get("muxed.m3u8").toString();
  const segmentNames = muxed.split(/\r?\n/).filter(line => line.endsWith(".ts"));
  const key = Buffer.from("0123456789abcdef"); assets.set("key.bin", key);
  let encrypted = muxed.replace("#EXTINF", '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF');
  let ranged = muxed;
  const combined = []; let offset = 0;
  for (const [index, name] of segmentNames.entries()) {
    const segment = assets.get(name);
    const iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(index), 8);
    const cipher = createCipheriv("aes-128-cbc", key, iv);
    const newName = `encrypted${index}.ts`;
    assets.set(newName, Buffer.concat([cipher.update(segment), cipher.final()]));
    encrypted = encrypted.replace(name, newName);
    ranged = ranged.replace(name, `#EXT-X-BYTERANGE:${segment.length}@${offset}\ncombined.ts`);
    combined.push(segment); offset += segment.length;
  }
  assets.set("encrypted.m3u8", Buffer.from(encrypted));
  assets.set("ranged.m3u8", Buffer.from(ranged)); assets.set("combined.ts", Buffer.concat(combined));
  assets.set("live.m3u8", Buffer.from(muxed.replace("#EXT-X-ENDLIST", "").replace("#EXT-X-PLAYLIST-TYPE:VOD", "")));
  assets.set("master.m3u8", Buffer.from('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,AUDIO="audio"\nvideo.m3u8'));
  assets.set("single.mpd", Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S" minBufferTime="PT1S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="200000" width="160" height="90" codecs="avc1.64000a"><BaseURL>input.mp4</BaseURL><SegmentBase indexRange="0-10"><Initialization range="0-100"/></SegmentBase></Representation></AdaptationSet></Period></MPD>'));
  assets.set("caf.mpd", Buffer.from(assets.get("single.mpd").toString().replace("input.mp4", "sample.caf")));
  assets.set("caf.m3u8", Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.1,\nsample.caf\n#EXT-X-ENDLIST'));
  assets.set("live.mpd", Buffer.from(assets.get("manifest.mpd").toString().replace('type="static"', `type="dynamic" availabilityStartTime="${new Date(Date.now() - 3000).toISOString()}" timeShiftBufferDepth="PT10S"`)));
  for (const [name, transport] of [["muxed.m3u8", "hls"], ["master.m3u8", "hls"], ["encrypted.m3u8", "hls"], ["ranged.m3u8", "hls"], ["fragmented.m3u8", "hls"], ["manifest.mpd", "dash"], ["single.mpd", "dash"], ["list.mpd", "dash"], ["live.mpd", "dash"], ["live.m3u8", "hls"]]) {
    const result = await page.evaluate(async ({ name, transport }) => {
      const { downloadStream } = await import("./src/stream-download.js");
      const messages = [];
      const sizes = [];
      const file = await downloadStream({ url: `${location.origin}/media/${name}`, transport }, { onProgress: (message, size) => { messages.push(message); if (size) sizes.push(size); } });
      const video = document.createElement("video"); video.muted = true; video.preload = "auto";
      const url = URL.createObjectURL(file); video.src = url; document.body.append(video);
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error(video.error?.message)); });
      await video.play();
      await new Promise(resolve => setTimeout(resolve, 100));
      const metadata = { duration: video.duration, width: video.videoWidth, height: video.videoHeight, name: file.name, size: file.size, progressed: video.currentTime > 0, messages, sizes };
      const audio = new AudioContext();
      const decoded = await audio.decodeAudioData(await file.arrayBuffer());
      metadata.audioSamples = decoded.length;
      metadata.audible = decoded.getChannelData(0).some(sample => Math.abs(sample) > 0.01);
      await audio.close(); video.pause(); video.removeAttribute("src"); video.load(); video.remove(); URL.revokeObjectURL(url);
      return metadata;
    }, { name, transport });
    assert.equal(result.width, 160); assert.equal(result.height, 90);
    assert.ok(result.duration >= 1.9 && result.duration < 2.5, JSON.stringify(result));
    assert.equal(result.progressed, true);
    assert.equal(result.audible, true);
    assert.ok(result.audioSamples > 80000);
    assert.ok(result.sizes.some(size => size.loadedBytes > 0));
    assert.ok(result.sizes.at(-1).loadedBytes > 0);
    assert.equal(result.sizes.at(-1).totalBytes, result.sizes.at(-1).loadedBytes);
    if (name.startsWith("live.")) assert.match(result.name, /live-fragment/);
    console.log(`${name}: decoded ${result.width}×${result.height}, ${result.duration.toFixed(2)}s, audible audio, ${result.size} bytes.`);
  }
  for (const [name, transport] of [["caf.m3u8", "hls"], ["caf.mpd", "dash"]]) {
    const result = await page.evaluate(async ({ name, transport }) => {
      const { downloadStream } = await import("./src/stream-download.js");
      const NativeWorker = window.Worker;
      const logs = [];
      const exits = [];
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            if (data.type === "LOG") logs.push(data.data.message);
            if (data.type === "EXEC") exits.push(data.data);
          });
        }
      };
      try {
        await downloadStream({ url: `${location.origin}/media/${name}`, transport });
        return { logs, exits, saved: true };
      } catch (error) { return { logs, exits, saved: false, error: error.message }; }
      finally { window.Worker = NativeWorker; }
    }, { name, transport });
    assert.equal(result.saved, false, `${name} must reject the unexpected CAF container`);
    assert.deepEqual(result.exits, [1, 1], "Both output attempts must fail at input validation");
    assert.ok(result.logs.some(line => /\[caf @.*Format not on whitelist/.test(line)), JSON.stringify(result));
    assert.ok(!result.logs.some(line => /Input #0/.test(line)), "CAF headers must not be accepted");
    console.log(`${name}: CAF rejected by the format whitelist before header parsing.`);
  }
  assets.set("drm.mpd", Buffer.from(assets.get("manifest.mpd").toString().replace(/<AdaptationSet([^>]*)>/, '<AdaptationSet$1><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>')));
  assert.match(await page.evaluate(async () => {
    const { downloadStream } = await import("./src/stream-download.js");
    try { await downloadStream({ url: `${location.origin}/media/drm.mpd`, transport: "dash" }); }
    catch (error) { return error.message; }
  }), /DRM/);
  assets.set("oversized.mpd", Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"><SegmentTemplate timescale="1" initialization="init.mp4" media="chunk-$Number$.m4s"><SegmentTimeline><S d="1" r="999999999"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>'));
  assert.match(await page.evaluate(async () => {
    const { planStream } = await import("./src/stream-download.js");
    try { await planStream({ url: `${location.origin}/media/oversized.mpd`, transport: "dash" }); }
    catch (error) { return error.message; }
  }), /Слишком/);
  assert.equal(await page.evaluate(async () => {
    const { downloadStream } = await import("./src/stream-download.js");
    const controller = new AbortController();
    try { await downloadStream({ url: `${location.origin}/media/muxed.m3u8`, transport: "hls" }, { signal: controller.signal, onProgress: message => { if (message.startsWith("Загружено сегментов")) controller.abort(); } }); }
    catch (error) { return error.name; }
  }), "AbortError");
  assert.ok(requested.includes("/media/combined.ts"));
  await context.route("http://cdn.test/**", route => route.fulfill({ body: assets.get(new URL(route.request().url()).pathname.slice(1)) }));
  assets.set("external.m3u8", Buffer.from(muxed.replace(/^(muxed\d+\.ts)$/gm, "http://cdn.test/$1")));
  assets.set("slow.m3u8", Buffer.from(muxed));
  const source = await context.newPage();
  await source.goto("http://localhost:8123/source.html");
  await source.evaluate(async () => {
    performance.clearResourceTimings();
    await (await fetch("/media/master.m3u8")).arrayBuffer();
    window.testMediaSource = new MediaSource();
    document.querySelector("video").src = URL.createObjectURL(testMediaSource);
  });
  await context.exposeBinding("streamScan", (_binding, args) => source.evaluate(`(${collectPageMedia.toString()})(...${JSON.stringify(args)})`));
  const initialize = ({ manifest }) => {
    const url = "http://localhost:8123/source.html";
    const bookmark = { id: "b1", parentId: "folder", title: "Потоковое видео", url };
    const tree = { id: "0", title: "", children: [{ id: "folder", parentId: "0", title: "Видео", children: [bookmark] }] };
    const stored = {};
    const allowed = () => JSON.parse(localStorage.getItem("streamPermissions") || '["http://localhost/*"]');
    window.chrome = {
      runtime: { getManifest: () => manifest },
      tabs: { query: async () => [{ id: 1, url, title: bookmark.title }], get: async () => ({ id: 1, url }) },
      bookmarks: { getTree: async () => [tree], get: async () => [bookmark], search: async () => [bookmark] },
      storage: { local: { set: async values => Object.assign(stored, values), get: async key => ({ [key]: stored[key] }) } },
      scripting: { executeScript: async ({ args }) => [{ result: await window.streamScan(args) }] },
      permissions: {
        contains: async ({ origins }) => origins.every(origin => allowed().includes(origin)),
        request: async ({ origins }) => { localStorage.setItem("streamPermissions", JSON.stringify([...new Set([...allowed(), ...origins])])); return true; }
      }
    };
    FileSystemHandle.prototype.queryPermission = async () => "granted";
  };
  console.log("Starting background UI verification");
  const harness = await downloadHarness(context, page, initialize, manifest);
  await page.reload();
  await page.addScriptTag({ url: "http://localhost:8123/vendor/sql-wasm.js" });
  await page.evaluate(async () => {
    const { setResourceDirectory } = await import("./src/resource-directory.js");
    await setResourceDirectory(await (await navigator.storage.getDirectory()).getDirectoryHandle("Streams", { create: true }));
  });
  await page.goto("http://localhost:8123/tab.html");
  const waitSaved = () => page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue") || "null")?.jobs.at(-1)?.status === "done" && !document.querySelector("#tab-media-status").textContent.startsWith("Запуск"), null, { timeout: 10000 }).catch(async error => {
    throw new Error(`${error.message}\n${await page.locator(".download-job:last-child .download-status").textContent()}\n${await page.locator("#tab-media-list").textContent()}`);
  });
  const listSaved = () => page.evaluate(async () => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    return (await openResourceLibrary(await getResourceDirectory())).listResources();
  });
  const waitCached = count => page.evaluate(async count => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const directory = await getResourceDirectory();
    const SQL = await initSqlJs({ locateFile: () => new URL("./vendor/sql-wasm.wasm", location.href).href });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      let database;
      try {
        const bytes = await (await (await directory.getFileHandle("catalog.sqlite")).getFile()).arrayBuffer();
        database = new SQL.Database(new Uint8Array(bytes));
        const result = database.exec("SELECT COUNT(*) FROM resources r JOIN resource_previews p ON p.resource_id=r.id JOIN resource_timelapses t ON t.resource_id=r.id WHERE r.media_type LIKE 'video/%'");
        if (result[0]?.values[0][0] >= count) return true;
      } catch { /* The catalog can be replaced by a background commit during this read. */ }
      finally { database?.close(); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }, count);
  const playPreview = async () => {
    await page.getByRole("button", { name: "Воспроизвести превью: Видео 1", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".tab-media-preview video")?.currentTime > 0, null, { timeout: 15000 });
    assert.equal(await page.locator(".tab-media-preview video").evaluate(video => video.controls && video.videoWidth === 160), true);
  };
  await playPreview();
  assert.equal((await listSaved()).length, 0);
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  await waitSaved();
  assert.equal((await listSaved()).length, 1);
  assert.equal(await waitCached(1), true, "Downloaded video must get both caches without hovering");
  console.log("Background HLS saved and previews prepared");
  await source.setContent('<video src="http://localhost:8123/media/manifest.mpd"></video>');
  await page.locator("#tab-rescan").click();
  await playPreview();
  assert.equal((await listSaved()).length, 1);
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  await waitSaved();
  assert.equal((await listSaved()).length, 2);
  await source.setContent('<video src="http://localhost:8123/media/external.m3u8"></video>');
  await page.locator("#tab-rescan").click();
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  await page.getByRole("button", { name: "Разрешить доступ и загрузить", exact: true }).click();
  await waitSaved();
  assert.equal((await listSaved()).length, 3);
  console.log("Starting popup lifecycle checks");
  await source.setContent('<video src="http://localhost:8123/media/slow.m3u8"></video>', {waitUntil: "domcontentloaded"});
  await page.locator("#tab-rescan").click();
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue"))?.jobs.at(-1)?.status === "downloading");
  const cancelledId = await page.evaluate(async () => (await chrome.storage.local.get("downloadQueue")).downloadQueue.jobs.at(-1).id);
  await page.close();
  page = await harness.reopen();
  await page.getByRole("button", { name: "Отменить загрузку", exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get("downloadQueue")).downloadQueue.jobs.at(-1).id), cancelledId);
  if (process.env.BACKGROUND_SCREENSHOT) await page.screenshot({ path: process.env.BACKGROUND_SCREENSHOT });
  await page.getByRole("button", { name: "Отменить загрузку", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue"))?.jobs.at(-1)?.status === "cancelled");
  assert.equal((await listSaved()).length, 3);
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue"))?.jobs.at(-1)?.status === "downloading");
  const backgroundId = await page.evaluate(async () => (await chrome.storage.local.get("downloadQueue")).downloadQueue.jobs.at(-1).id);
  await page.close();
  page = await harness.reopen();
  await page.getByRole("button", { name: "Отменить загрузку", exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get("downloadQueue")).downloadQueue.jobs.at(-1).id), backgroundId);
  await page.close();
  await harness.background.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue"))?.jobs.at(-1)?.status === "done", null, { timeout: 15000 });
  page = await harness.reopen();
  await waitSaved();
  assert.equal((await listSaved()).length, 4);
  assert.equal(await waitCached(4), true, "Preview preparation must continue after the popup closes");
  await page.reload();
  await waitSaved();
  assert.equal((await listSaved()).length, 4);
  const savedSize = await page.evaluate(async () => {
    const job = (await chrome.storage.local.get("downloadQueue")).downloadQueue.jobs.at(-1);
    return { loaded: job.loadedBytes, total: job.totalBytes };
  });
  assert.ok(savedSize.loaded > 0);
  assert.equal(savedSize.loaded, savedSize.total);
  assert.match(await page.locator(".download-size").last().textContent(), /[\d,]+ [КМГ]?Б \/ [\d,]+ [КМГ]?Б/);
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue"))?.jobs.at(-1)?.status === "downloading");
  await harness.crashWorker();
  await page.close();
  page = await harness.reopen();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue"))?.jobs.at(-1)?.status === "interrupted");
  assert.equal((await listSaved()).length, 4);
  console.log("Starting multi-video queue verification");
  let releaseFirst;
  gates.set("/media/queue-first.m3u8", new Promise(resolve => { releaseFirst = resolve; }));
  assets.set("queue-first.m3u8", Buffer.from(muxed));
  assets.set("queue-second.m3u8", Buffer.from(muxed));
  assets.set("queue-broken.m3u8", Buffer.from("Not a playlist"));
  assets.set("queue-last.mpd", assets.get("manifest.mpd"));
  await source.setContent(["queue-first.m3u8", "queue-second.m3u8", "queue-broken.m3u8", "queue-last.mpd"].map(name => `<video src="http://localhost:8123/media/${name}"></video>`).join(""), { waitUntil: "domcontentloaded" });
  await page.locator("#tab-rescan").click();
  await page.waitForFunction(() => document.querySelectorAll(".tab-media-card").length === 4);
  const beforeQueue = await page.evaluate(() => JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs.length);
  const queueSources = ["queue-first.m3u8", "queue-second.m3u8", "queue-broken.m3u8", "queue-last.mpd"];
  for (let index = 0; index < queueSources.length; index++) {
    await page.locator(".tab-media-card").filter({ hasText: queueSources[index] }).getByRole("button", { name: "Загрузить", exact: true }).click();
    await page.waitForFunction(count => JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs.length === count, beforeQueue + index + 1);
  }
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs.slice(-4));
  assert.deepEqual(queued.map(job => job.status), ["downloading", "queued", "queued", "queued"]);
  const duplicate = await page.evaluate(async job => (await chrome.runtime.sendMessage({ target: "download-background", type: "start", payload: job })).value, queued[1]);
  assert.equal(duplicate.jobs.length, beforeQueue + 4);
  await page.close();
  page = await harness.reopen();
  await page.setViewportSize({ width: 620, height: 580 });
  for (const job of queued) await page.locator(`.download-job[data-id="${job.id}"]`).waitFor();
  await page.getByRole("button", { name: "Очистить завершённые", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".download-job").length === 4);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs.map(job => job.id)), queued.map(job => job.id));
  assert.equal(await page.locator("#download-clear").isDisabled(), true);
  assert.equal((await listSaved()).length, 4);
  assert.equal(await page.locator(".download-job[data-status='queued'] .download-cancel").count(), 3);
  await page.locator(`.download-job[data-id="${queued[1].id}"] .download-cancel`).click();
  await page.locator(`.download-job[data-id="${queued[1].id}"][data-status="cancelled"]`).waitFor();
  if (process.env.QUEUE_SCREENSHOT) await page.screenshot({ path: process.env.QUEUE_SCREENSHOT });
  await page.close();
  releaseFirst();
  await harness.background.waitForFunction(ids => {
    const jobs = JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs;
    return ids.every((id, index) => jobs.find(job => job.id === id)?.status === ["done", "cancelled", "error", "done"][index]);
  }, queued.map(job => job.id), { timeout: 20000 }).catch(async error => {
    console.error(await harness.background.evaluate(() => JSON.parse(localStorage.getItem("harness-downloadQueue"))));
    throw error;
  });
  page = await harness.reopen();
  assert.equal((await listSaved()).length, 6);

  let releaseCancelled;
  gates.set("/media/queue-cancel.m3u8", new Promise(resolve => { releaseCancelled = resolve; }));
  assets.set("queue-cancel.m3u8", Buffer.from(muxed));
  assets.set("queue-after.mpd", assets.get("manifest.mpd"));
  await source.setContent('<video src="http://localhost:8123/media/queue-cancel.m3u8"></video><video src="http://localhost:8123/media/queue-after.mpd"></video>', { waitUntil: "domcontentloaded" });
  await page.locator("#tab-rescan").click();
  await page.waitForFunction(() => document.querySelectorAll(".tab-media-card").length === 2);
  await page.locator(".tab-media-card").nth(0).getByRole("button", { name: "Загрузить", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs.at(-1).status === "downloading");
  await page.locator(".tab-media-card").nth(1).getByRole("button", { name: "Загрузить", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs.at(-1).status === "queued");
  const cancelledQueue = await page.evaluate(() => JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs.slice(-2));
  await page.close();
  page = await harness.reopen();
  await page.locator(`.download-job[data-id="${cancelledQueue[0].id}"] .download-cancel`).click();
  releaseCancelled();
  await page.locator(`.download-job[data-id="${cancelledQueue[0].id}"][data-status="cancelled"]`).waitFor();
  await page.locator(`.download-job[data-id="${cancelledQueue[1].id}"][data-status="done"]`).waitFor();
  assert.equal((await listSaved()).length, 7);
  await page.getByRole("button", { name: "Очистить завершённые", exact: true }).click();
  await page.locator("#download-panel").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".download-job").count(), 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#tab-media-status").textContent.startsWith("Найдено"));
  assert.equal(await page.locator("#download-panel").isHidden(), true);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs), []);
  assert.equal((await listSaved()).length, 7);
  console.log("Starting failed/interrupted retry verification without media on the source page");
  assets.set("retry-error.m3u8", Buffer.from("Not a playlist"));
  await source.setContent('<video src="http://localhost:8123/media/retry-error.m3u8"></video>', { waitUntil: "domcontentloaded" });
  await page.locator("#tab-rescan").click();
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  const failedRow = page.locator('.download-job[data-status="error"]');
  await failedRow.waitFor();
  const failedId = await failedRow.getAttribute("data-id");
  await source.setContent("<p>The player is no longer on the page</p>");
  assets.set("retry-error.m3u8", Buffer.from(muxed));
  await page.close();
  page = await harness.reopen();
  await page.locator(`.download-job[data-id="${failedId}"] .download-retry`).click();
  await page.locator(`.download-job[data-id="${failedId}"][data-status="done"]`).waitFor();
  assert.equal((await listSaved()).length, 8);
  assert.equal(await page.locator(".download-job").count(), 1);
  assert.equal(await page.locator(`.download-job[data-id="${failedId}"] .download-retry`).isHidden(), true);

  let releaseInterrupted;
  gates.set("/media/retry-interrupted.m3u8", new Promise(resolve => { releaseInterrupted = resolve; }));
  assets.set("retry-interrupted.m3u8", Buffer.from(muxed));
  await source.setContent('<video src="http://localhost:8123/media/retry-interrupted.m3u8"></video>', { waitUntil: "domcontentloaded" });
  await page.locator("#tab-rescan").click();
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  const interruptedRow = page.locator('.download-job[data-status="downloading"]');
  await interruptedRow.waitFor();
  const interruptedId = await interruptedRow.getAttribute("data-id");
  await harness.crashWorker();
  await source.setContent("<p>No video here</p>", { waitUntil: "domcontentloaded" });
  await page.close();
  page = await harness.reopen();
  await page.locator(`.download-job[data-id="${interruptedId}"][data-status="interrupted"] .download-retry`).click();
  await page.locator(`.download-job[data-id="${interruptedId}"][data-status="downloading"]`).waitFor();
  await page.close();
  releaseInterrupted();
  await harness.background.waitForFunction(id => JSON.parse(localStorage.getItem("harness-downloadQueue")).jobs.find(job => job.id === id)?.status === "done", interruptedId, { timeout: 15000 });
  page = await harness.reopen();
  assert.equal((await listSaved()).length, 9);
  assert.equal(await page.locator(".download-job").count(), 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(harness.errors, []);
  console.log("Verified HLS TS/fMP4, separate audio, AES-128, byte ranges, DASH, live snapshot, decoded audio/video, DRM rejection, UI import into SQLite, CDN permissions, popup close/reopen, cancellation, completion without duplicate resources and interrupted worker recovery under the extension CSP.");
} finally { await browser.close(); }
