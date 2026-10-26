import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { downloadHarness } from "./download-harness.mjs";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url)));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 780, height: 800 } });
  let releaseDirectDownload;
  const directDownloadReady = new Promise(resolve => { releaseDirectDownload = resolve; });
  await context.route("http://localhost:8124/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/report.pdf") return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\nDirect bookmark resource" });
    if (path === "/missing.bin") return route.fulfill({ status: 404, body: "missing" });
    await directDownloadReady;
    return route.fulfill({ contentType: "application/octet-stream", body: Buffer.alloc(600000, 42) });
  });
  await context.route("http://localhost:8123/**", async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === "fixture.html") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture</title>" });
    const contentType = { js: "text/javascript", html: "text/html", css: "text/css", svg: "image/svg+xml", wasm: "application/wasm" }[path.split(".").pop()];
    await route.fulfill({ body: await readFile(new URL(`../${path}`, import.meta.url)), contentType });
  });
  const initialize = () => {
    const event = { addListener() {} };
    const bookmark = { id: "bookmark", parentId: "folder", title: "Закладка без открытой вкладки", url: "https://bookmark.invalid/page" };
    const other = { ...bookmark, id: "other", title: "Выбранная закладка" };
    const bookmarks = () => localStorage.getItem("manualNoBookmarks") ? JSON.parse(localStorage.getItem("manualCreated") || "[]") : localStorage.getItem("manualTab") ? [bookmark, other] : [bookmark];
    const currentTab = () => {
      if (!localStorage.getItem("manualTab")) throw new Error("Direct downloads must not access a source tab");
      return { id: 7, url: bookmark.url, title: bookmark.title };
    };
    window.chrome = {
      runtime: {},
      tabs: { get: async () => currentTab(), query: async () => localStorage.getItem("manualTab") ? [currentTab()] : [] },
      scripting: { executeScript: async () => [] },
      bookmarks: { getTree: async () => [{ id: "0", title: "", children: [{ id: "folder", parentId: "0", title: "Папка", children: bookmarks() }] }], get: async id => bookmarks().filter(bookmark => bookmark.id === id), search: async () => [],
        create: async node => { const created = { ...node, id: "created", parentId: "folder" }; localStorage.setItem("manualCreated", JSON.stringify([created])); return created; },
        onCreated: event, onRemoved: event, onChanged: event, onMoved: event, onChildrenReordered: event, onImportEnded: event },
      permissions: {
        request: async request => { window.testPermission = request; if (window.allowHost === false) return false; localStorage.setItem("directHost", request.origins[0]); return true; },
        contains: async ({ origins }) => origins.every(origin => origin === localStorage.getItem("directHost"))
      }
    };
  };
  const page = await context.newPage();
  const harness = await downloadHarness(context, page, initialize, manifest);
  await page.goto("http://localhost:8123/fixture.html");
  await page.evaluate(async () => {
    const { setResourceDirectory } = await import("./src/resource-directory.js");
    await setResourceDirectory(await (await navigator.storage.getDirectory()).getDirectoryHandle("Resources", { create: true }));
  });
  await page.goto("http://localhost:8123/popup.html");
  await page.locator("#search").waitFor({ state: "visible" });
  const directBookmark = await page.evaluate(async () => {
    const [root] = await chrome.bookmarks.getTree();
    return root.children[0].children.find(node => node.url);
  });
  await page.evaluate(async bookmark => (await import("./src/resources-ui.js")).openBookmarkResources(bookmark), directBookmark);
  await page.locator("#resource-url-download").waitFor();
  await page.locator("#resource-url").fill("file:///secret.txt");
  await page.locator("#resource-url-download").click();
  assert.match(await page.locator("#resource-message").textContent(), /HTTP или HTTPS/);
  await page.evaluate(() => { window.allowHost = false; });
  await page.locator("#resource-url").fill("http://localhost:8124/report.pdf");
  await page.locator("#resource-url-download").click();
  await page.waitForFunction(() => document.querySelector("#resource-message").textContent.includes("не предоставлен"));
  await page.evaluate(() => { window.allowHost = true; });
  await page.locator("#resource-url-download").click();
  await page.waitForFunction(() => [...document.querySelectorAll("#resource-list li")].some(node => node.textContent.includes("report.pdf")));
  assert.match(await page.locator("#resource-message").textContent(), /Сохранено/);
  assert.deepEqual(await page.evaluate(() => testPermission), { origins: ["http://localhost/*"] });
  const imported = await page.evaluate(async bookmarkId => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await (await import("./src/resource-library.js")).openResourceLibrary(await getResourceDirectory());
    const resource = (await library.getBookmark(bookmarkId)).resources.find(resource => resource.name === "report.pdf");
    return { type: resource.mediaType, contents: await (await library.getFile(resource.id)).text() };
  }, directBookmark.id);
  assert.equal(imported.type, "application/pdf");
  assert.equal(imported.contents, "%PDF-1.4\nDirect bookmark resource");
  await page.locator("#resource-url").fill("http://localhost:8124/missing.bin");
  await page.locator("#resource-url-download").click();
  await page.waitForFunction(() => document.querySelector("#resource-message").textContent.includes("HTTP 404"));
  await page.locator("#resource-url").fill("http://localhost:8124/background.bin");
  await page.locator("#resource-url-download").click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue"))?.jobs.at(-1)?.status === "downloading" && !document.querySelector("#resource-url-download").disabled);
  await page.close();
  releaseDirectDownload();
  const reopened = await harness.reopen();
  await reopened.waitForFunction(() => JSON.parse(localStorage.getItem("harness-downloadQueue"))?.jobs.at(-1)?.status === "done");
  assert.equal(await reopened.evaluate(async bookmarkId => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await (await import("./src/resource-library.js")).openResourceLibrary(await getResourceDirectory());
    return (await library.getBookmark(bookmarkId)).resources.some(resource => resource.name === "background.bin" && resource.mediaType === "application/octet-stream");
  }, directBookmark.id), true, "The direct file must be saved to the selected bookmark after its window closes");
  await reopened.evaluate(() => localStorage.setItem("manualTab", "true"));
  await reopened.reload();
  await reopened.waitForFunction(() => !document.querySelector("#tab-manual-upload").disabled);
  await reopened.locator("#tab-bookmark").selectOption("other");
  const pagesBefore = context.pages().length;
  await reopened.getByRole("button", { name: "Загрузить вручную", exact: true }).click();
  await reopened.waitForFunction(() => !document.querySelector("#resource-upload").disabled);
  assert.equal(context.pages().length, pagesBefore, "Manual upload must open in the same popup");
  assert.equal(await reopened.locator("#resource-title").textContent(), "Выбранная закладка");
  await reopened.locator("#resource-files").setInputFiles({ name: "Manual.txt", mimeType: "text/plain", buffer: Buffer.from("Manual upload") });
  await reopened.waitForFunction(() => document.querySelector("#resource-list").textContent.includes("Manual.txt"));
  await reopened.locator("#resource-url").fill("http://localhost:8124/report.pdf");
  await reopened.locator("#resource-url-download").click();
  await reopened.waitForFunction(() => document.querySelector("#resource-list").textContent.includes("report.pdf"));
  await reopened.getByRole("button", { name: "Закрыть ресурсы", exact: true }).click();
  assert.equal(await reopened.locator("#resource-dialog").evaluate(dialog => dialog.open), false);
  assert.deepEqual(await reopened.evaluate(async () => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await (await import("./src/resource-library.js")).openResourceLibrary(await getResourceDirectory());
    return (await library.getBookmark("other")).resources.map(resource => resource.name).sort();
  }), ["Manual.txt", "report.pdf"]);
  await reopened.evaluate(() => localStorage.setItem("manualNoBookmarks", "true"));
  await reopened.reload();
  await reopened.waitForFunction(() => !document.querySelector("#tab-manual-upload").disabled);
  await reopened.getByRole("button", { name: "Загрузить вручную", exact: true }).click();
  await reopened.waitForFunction(() => !document.querySelector("#resource-upload").disabled);
  await reopened.locator("#resource-files").setInputFiles({ name: "New bookmark.txt", mimeType: "text/plain", buffer: Buffer.from("New bookmark resource") });
  await reopened.waitForFunction(() => document.querySelector("#resource-list").textContent.includes("New bookmark.txt"));
  assert.equal(await reopened.evaluate(() => JSON.parse(localStorage.getItem("manualCreated"))[0].url), "https://bookmark.invalid/page");
  assert.deepEqual(harness.errors, []);
  console.log("Verified direct bookmark imports: PDF contents, URL validation, denied host access, HTTP errors and background completion after closing the UI with no source tab.");
} finally { await browser.close(); }
