import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { collectPageMedia } from "../src/page-media.js";
import { readFrameBlob } from "../src/media-scan.js";
import { readMediaSize } from "../src/media-size.js";
import { downloadHarness } from "./download-harness.mjs";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url)));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 620, height: 580 } });
  const fixture = await context.newPage();
  const assets = await fixture.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 800;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#4b6385"; ctx.fillRect(0, 0, 1200, 800);
    ctx.fillStyle = "#b5ac86"; ctx.fillRect(120, 120, 960, 560);
    const image = [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve))).arrayBuffer())];
    const stream = canvas.captureStream(0);
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(100);
    for (let frame = 0; frame < 8; frame++) {
      ctx.fillStyle = frame % 2 ? "#527257" : "#4b6385"; ctx.fillRect(300, 200, 600, 400);
      stream.getVideoTracks()[0].requestFrame();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    return { image, video: [...new Uint8Array(await new Blob(chunks).arrayBuffer())] };
  });
  await fixture.close();
  await context.route("http://localhost:8124/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/article") await route.fulfill({ contentType: "text/html", body: '<h1>Статья с иллюстрацией</h1><img src="/large.png"><img src="/large.png" width="100" height="100">' });
    else {
      const body = Buffer.from(path.endsWith("webm") ? assets.video : assets.image);
      await route.fulfill({ contentType: path.endsWith("webm") ? "video/webm" : "image/png", headers: { "Content-Length": String(body.length) }, body });
    }
  });
  await context.route("http://127.0.0.1:8125/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/player") return route.fulfill({ contentType: "text/html", body: '<!doctype html><video poster="/poster.png"></video><script type="module">const data = await (await fetch("/clip.webm")).blob(); const file = new Blob([data, new Uint8Array(600000)], {type:"video/webm"}); document.querySelector("video").src = URL.createObjectURL(file);</script>' });
    return route.fulfill({ contentType: pathname.endsWith("webm") ? "video/webm" : "image/png", body: Buffer.from(pathname.endsWith("webm") ? assets.video : assets.image) });
  });
  await context.route("https://www.youtube.com/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: "text/html", body: path.startsWith("/embed/")
      ? `<video src="data:video/webm;base64,${Buffer.from(assets.video).toString("base64")}" autoplay muted loop controls></video>`
      : '<video></video><script>document.querySelector("video").src = URL.createObjectURL(new MediaSource());</script>' });
  });
  await context.route("http://localhost:8123/**", async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === "fixture.html") { await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture</title>" }); return; }
    const type = { js: "text/javascript", html: "text/html", css: "text/css", svg: "image/svg+xml", wasm: "application/wasm" }[path.split(".").pop()];
    await route.fulfill({ body: await readFile(new URL(`../${path}`, import.meta.url)), contentType: type, headers: { "Content-Security-Policy": manifest.content_security_policy.extension_pages } });
  });
  const source = await context.newPage();
  await source.goto("http://localhost:8124/article");
  await source.waitForFunction(() => [...document.images].every(image => image.complete));
  const page = await context.newPage();
  const sourceFrame = id => id ? source.frames().find(frame => frame.url() === "http://127.0.0.1:8125/player") : source.mainFrame();
  await context.exposeBinding("fixtureFrames", () => source.frames().map(frame => ({ frameId: frame === source.mainFrame() ? 0 : 1, parentFrameId: frame === source.mainFrame() ? -1 : 0, url: frame.url() })));
  await context.exposeBinding("scanFixture", (_binding, { frameId, name, args }) => {
    const func = name === "readFrameBlob" ? readFrameBlob : name === "readMediaSize" ? readMediaSize : collectPageMedia;
    return sourceFrame(frameId).evaluate(`(${func.toString()})(...${JSON.stringify(args || [])})`);
  });
  const initialize = ({ manifest }) => {
    const event = { addListener() {} };
    const url = "http://localhost:8124/article";
    const initial = { id: "0", title: "", children: [{ id: "folder", parentId: "0", title: "Работа", children: [
      { id: "a", parentId: "folder", title: "Статья с иллюстрацией", url }, { id: "b", parentId: "folder", title: "Вторая закладка", url }
    ] }] };
    const readTree = () => JSON.parse(localStorage.getItem("testTree") || JSON.stringify(initial));
    const bookmarks = () => readTree().children.flatMap(folder => folder.children);
    const tab = () => ({ id: 7, url: localStorage.getItem("testTabUrl") || url, title: "Статья с иллюстрацией" });
    window.chrome = {
      runtime: { getManifest: () => manifest },
      declarativeNetRequest: { updateSessionRules: async rules => localStorage.setItem("testYoutubeRules", JSON.stringify(rules)) },
      tabs: { query: async () => [tab()], get: async () => tab() },
      webNavigation: { getAllFrames: async () => window.fixtureFrames() },
      scripting: { executeScript: async ({ func, target, args }) => { if (!["collectPageMedia", "readFrameBlob", "readMediaSize"].includes(func.name)) throw new Error("Unexpected injected function"); return [{ result: await window.scanFixture({ frameId: target.frameIds?.[0] || 0, name: func.name, args }) }]; } },
      permissions: {
        contains: async ({ origins }) => origins.every(origin => !origin.includes("127.0.0.1") || JSON.parse(localStorage.getItem("grantedOrigins") || "[]").includes(origin)),
        request: async request => {
          window.testPermission = request;
          if (window.allowHost === false) return false;
          localStorage.setItem("grantedOrigins", JSON.stringify([...new Set([...JSON.parse(localStorage.getItem("grantedOrigins") || "[]"), ...request.origins])])); return true;
        }
      },
      storage: { local: {
        get: async key => ({ [key]: JSON.parse(localStorage.getItem(`stored-${key}`) || "null") }),
        set: async values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(`stored-${key}`, JSON.stringify(value)); }
      } },
      bookmarks: {
        getTree: async () => [readTree()], search: async ({ url }) => bookmarks().filter(node => node.url === url),
        get: async id => bookmarks().filter(node => node.id === id),
        create: async node => {
          const tree = readTree(); const bookmark = { ...node, id: crypto.randomUUID(), parentId: "folder" };
          tree.children[0].children.push(bookmark); localStorage.setItem("testTree", JSON.stringify(tree)); return bookmark;
        }, onCreated: event, onRemoved: event, onChanged: event, onMoved: event, onImportEnded: event, onChildrenReordered: event
      }
    };
    FileSystemHandle.prototype.queryPermission = async () => localStorage.getItem("testDirectoryPermission") || "granted";
    FileSystemHandle.prototype.requestPermission = async () => { localStorage.removeItem("testDirectoryPermission"); return "granted"; };
  };
  const harness = await downloadHarness(context, page, initialize, manifest);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://localhost:8123/fixture.html");
  await page.addScriptTag({ url: "http://localhost:8123/vendor/sql-wasm.js" });
  await page.evaluate(async () => {
    const { setResourceDirectory } = await import("./src/resource-directory.js");
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("Ресурсы", { create: true });
    await setResourceDirectory(directory);
  });
  const resources = () => page.evaluate(async () => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    return (await openResourceLibrary(await getResourceDirectory())).listResources();
  });
  await page.goto("http://localhost:8123/tab.html");
  assert.equal(await page.evaluate(() => Boolean(document.querySelector(".tab-media").compareDocumentPosition(document.querySelector("#download-panel")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  await page.waitForFunction(() => document.querySelectorAll(".tab-media-card").length === 1 && !document.querySelector(".tab-media-card-body > button").disabled);
  await page.waitForFunction(() => document.querySelector(".tab-media-preview img")?.naturalWidth === 1200);
  await page.waitForFunction(() => /Размер: [\d\s,]+ [КМГ]?Б/.test(document.querySelector(".tab-media-size")?.textContent));
  assert.match(await page.locator("#tab-bookmark-info").textContent(), /Закладок: 2/);
  if (process.env.TAB_SCREENSHOT) await page.screenshot({ path: process.env.TAB_SCREENSHOT });
  await page.getByRole("link", { name: "Закладки и ресурсы", exact: true }).click();
  await page.getByRole("link", { name: "Назад к текущей вкладке", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".tab-media-card-body > button") && !document.querySelector(".tab-media-card-body > button").disabled);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("link", { name: "Назад к вкладке", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".tab-media-card-body > button") && !document.querySelector(".tab-media-card-body > button").disabled);
  assert.equal(context.pages().length, 3);
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue") || "null")?.jobs.at(-1)?.status === "done" && !document.querySelector("#tab-media-status").textContent.startsWith("Запуск"));
  assert.deepEqual(await page.evaluate(() => testPermission), { origins: ["http://localhost/*"] });
  let saved = await resources();
  assert.equal(saved.length, 1); assert.equal(saved[0].bookmarkId, "a"); assert.equal(saved[0].mediaType, "image/png");
  await page.locator("#tab-bookmark").selectOption("b");
  await page.locator("#tab-rescan").click();
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue") || "null")?.jobs.at(-1)?.status === "done" && !document.querySelector("#tab-media-status").textContent.startsWith("Запуск"));
  saved = await resources(); assert.deepEqual(saved.map(item => item.bookmarkId).sort(), ["a", "b"]);

  await source.setContent('<video width="400" height="240" src="http://localhost:8124/clip.webm" poster="http://localhost:8124/large.png"></video><video width="200" height="120" src="blob:http://localhost/stream" poster="http://localhost:8124/large.png"></video><img src="http://localhost:8124/large.png">');
  await page.locator("#tab-rescan").click();
  await page.waitForFunction(() => document.querySelectorAll(".tab-media-card").length === 2);
  await page.getByRole("button", { name: "Воспроизвести превью: Видео 1", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".tab-media-preview video")?.currentTime > 0);
  assert.equal(await page.locator(".tab-media-preview video").evaluate(video => video.controls && Boolean(video.poster)), true);
  if (process.env.VIDEO_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.VIDEO_PREVIEW_SCREENSHOT });
  assert.equal(await page.locator(".tab-media-card-body > button").nth(1).isDisabled(), true);
  await page.locator(".tab-media-card-body > button").first().click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue") || "null")?.jobs.at(-1)?.status === "done" && !document.querySelector("#tab-media-status").textContent.startsWith("Запуск"), null, { timeout: 10000 }).catch(async error => {
    throw new Error(`${error.message}\n${await page.locator(".download-job:last-child .download-status").textContent()}\n${await page.locator("#tab-media-list").textContent()}`);
  });
  saved = await resources(); assert.equal(saved.filter(item => item.mediaType === "video/webm").length, 1);
  await page.evaluate(() => { window.previousPreview = document.querySelector(".tab-media-preview video"); });
  await page.locator("#tab-rescan").click();
  assert.equal(await page.evaluate(() => previousPreview.paused && !previousPreview.getAttribute("src")), true);
  await page.evaluate(() => { window.allowHost = false; });
  await page.getByRole("button", { name: "Воспроизвести превью: Видео 1", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".preview-message")?.textContent.includes("не предоставлен"));
  assert.equal(await page.locator(".preview-play").first().isEnabled(), true);
  await page.locator(".tab-media-card-body > button").first().click();
  await page.waitForFunction(() => document.querySelector("#tab-media-status").textContent.includes("не предоставлен"));
  assert.equal((await resources()).length, 3);

  await page.evaluate(() => { localStorage.setItem("testTree", JSON.stringify({ id: "0", title: "", children: [{ id: "folder", parentId: "0", title: "Другие закладки", children: [] }] })); });
  await page.reload();
  await page.getByRole("button", { name: "Добавить закладку и загрузить", exact: true }).first().click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue") || "null")?.jobs.at(-1)?.status === "done" && !document.querySelector("#tab-media-status").textContent.startsWith("Запуск"));
  assert.equal((await resources()).length, 1);
  assert.match(await page.locator("#tab-bookmark-info").textContent(), /Ресурсов: 1/);

  await page.evaluate(() => localStorage.setItem("testDirectoryPermission", "prompt"));
  await page.reload();
  await page.getByRole("button", { name: "Разрешить доступ к папке" }).waitFor();
  assert.equal(await page.locator(".tab-media-card-body > button").first().isDisabled(), true);
  await page.getByRole("button", { name: "Разрешить доступ к папке" }).click();
  await page.waitForFunction(() => !document.querySelector(".tab-media-card-body > button").disabled);
  await page.evaluate(() => localStorage.setItem("testTabUrl", "https://changed.test/"));
  await page.locator(".tab-media-card-body > button").first().click();
  await page.waitForFunction(() => document.querySelector("#tab-media-status").textContent.includes("Адрес вкладки изменился"));
  assert.equal((await resources()).length, 1);
  await source.setContent('<img src="http://localhost:8124/large.png"><iframe src="http://127.0.0.1:8125/player"></iframe>');
  await source.frames().find(frame => frame.url() === "http://127.0.0.1:8125/player").waitForFunction(() => document.querySelector("video")?.src.startsWith("blob:"));
  await page.evaluate(() => localStorage.removeItem("testTabUrl"));
  await page.reload();
  await page.getByRole("button", { name: "Искать во встроенных плеерах" }).waitFor();
  await page.getByRole("button", { name: "Искать во встроенных плеерах" }).click();
  await page.waitForFunction(() => document.querySelector(".tab-media-card")?.textContent.includes("Blob") && !document.querySelector(".tab-media-card-body > button").disabled);
  assert.match(await page.locator(".tab-media-card").textContent(), /iframe/);
  await page.getByRole("button", { name: "Воспроизвести превью: Видео 1", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".tab-media-preview video")?.currentTime > 0);
  assert.equal((await resources()).length, 1);
  await page.getByRole("button", { name: "Загрузить", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue") || "null")?.jobs.at(-1)?.status === "done" && !document.querySelector("#tab-media-status").textContent.startsWith("Запуск"));
  saved = await resources();
  assert.equal(saved.length, 2);
  assert.ok(saved.some(item => item.mediaType === "video/webm" && item.size === assets.video.length + 600000));
  await source.setContent('<video></video><script>document.querySelector("video").src = URL.createObjectURL(new MediaSource());</script>');
  await page.locator("#tab-rescan").click();
  await page.getByRole("button", { name: "Воспроизвести превью: Видео 1", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".preview-message")?.textContent.includes("Не удалось прочитать blob"));
  assert.doesNotMatch(await page.locator(".preview-message").textContent(), /Cannot read properties|reading 'size'/);
  assert.equal((await resources()).length, 2);
  // The YouTube page and embedded player are fulfilled by local fixtures.
  await source.goto("https://www.youtube.com/watch?v=testVideo01");
  await page.evaluate(() => localStorage.setItem("testTabUrl", "https://www.youtube.com/watch?v=testVideo01"));
  await page.reload();
  await page.getByRole("button", { name: "Воспроизвести превью: Видео 1", exact: true }).click();
  assert.equal(await page.locator(".tab-media-card-body > button").first().isDisabled(), true, "YouTube must stay preview-only");
  const player = page.frameLocator(".tab-media-preview iframe").locator("video");
  await player.waitFor();
  await player.evaluate(video => new Promise(resolve => {
    if (video.currentTime > 0) resolve();
    else video.addEventListener("timeupdate", resolve, { once: true });
  }));
  assert.equal(await page.locator(".tab-media-preview iframe").getAttribute("src"), "https://www.youtube.com/embed/testVideo01?autoplay=1&mute=1&playsinline=1&rel=0");
  const rule = await page.evaluate(() => JSON.parse(localStorage.getItem("testYoutubeRules")).addRules[0]);
  assert.deepEqual(rule.condition.initiatorDomains, ["bookmark-test-extension"]);
  assert.deepEqual(rule.condition.resourceTypes, ["sub_frame"]);
  await page.locator("#tab-rescan").click();
  assert.equal(await page.locator(".tab-media-preview iframe").count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(harness.errors, []);
  console.log("Verified media scan/imports, bookmark selection/creation, permissions, navigation, cross-origin iframe discovery and chunked blob import into SQLite.");
} finally { await browser.close(); }
