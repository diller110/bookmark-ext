import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, join, dirname, basename } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const root = resolve(process.env.BOOKMARK_EXTENSION_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const profile = await mkdtemp(join(root, ".test-incognito-"));
// The user's browser profile is never opened.
const regular = await chromium.launchPersistentContext(profile, {
  channel: "chrome", headless: true, locale: "ru", ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging", "--lang=ru"]
});
try {
  const browser = regular.browser();
  const cdp = await browser.newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", {
    path: root, enableInIncognito: true
  });
  const base = `chrome-extension://${id}/`;
  let normal = await regular.newPage();
  await normal.goto(`${base}popup.html`);
  await normal.bringToFront();
  const bookmark = await normal.evaluate(async () => {
    const [root] = await chrome.bookmarks.getTree();
    return chrome.bookmarks.create({ parentId: root.children[0].id, title: "Incognito bookmark fixture", url: "https://bookmark-fixture.invalid/article" });
  });
  await normal.evaluate(async bookmarkId => {
    const { setResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("Resources", { create: true });
    await setResourceDirectory(directory);
    const library = await openResourceLibrary(directory);
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
    const context = canvas.getContext("2d"); context.fillStyle = "#6b8a5e"; context.fillRect(0, 0, 640, 480);
    const image = await new Promise(resolve => canvas.toBlob(resolve));
    const stream = canvas.captureStream(0);
    document.body.append(canvas);
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(100);
    for (let frame = 0; frame < 12; frame++) {
      context.fillStyle = frame % 2 ? "#8c684e" : "#6b8a5e";
      context.fillRect(80, 80, 320, 240);
      stream.getVideoTracks()[0].requestFrame();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    canvas.remove();
    if (!chunks.reduce((sum, chunk) => sum + chunk.size, 0)) throw new Error("The recording fixture produced an empty video");
    await library.attach(bookmarkId, [new File([image], "Shared image.png", { type: "image/png" }), new File([new Uint8Array(600000).fill(42)], "Shared file.bin", { type: "application/octet-stream" }), new File(chunks, "Shared video.webm", { type: "video/webm" })]);
    await library.setTags(bookmarkId, ["общая библиотека"]);
  }, bookmark.id);
  await normal.close();
  normal = await regular.newPage();
  await normal.goto(`${base}settings.html`);
  assert.equal(await normal.evaluate(async () => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const directory = await getResourceDirectory();
    const SQL = await initSqlJs({ locateFile: () => chrome.runtime.getURL("vendor/sql-wasm.wasm") });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      let database;
      try {
        const bytes = await (await (await directory.getFileHandle("catalog.sqlite")).getFile()).arrayBuffer();
        database = new SQL.Database(new Uint8Array(bytes));
        const result = database.exec(`SELECT COUNT(*) FROM resources r
          JOIN resource_previews p ON p.resource_id=r.id
          JOIN resource_timelapses t ON t.resource_id=r.id WHERE r.media_type LIKE 'video/%'`);
        if (result[0]?.values[0][0] === 1) return true;
      } catch { /* The background writer may replace the catalog during this read. */ }
      finally { database?.close(); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }), true, "Both preview caches must be prepared after import with the original extension window closed, before any hover");
  await normal.evaluate(async () => {
    await chrome.runtime.sendMessage({ target: "download-background", type: "status", payload: {} });
    await navigator.locks.request("bookmark-download-job", () => chrome.storage.local.set({ downloadQueue: {
      revision: 10, jobs: [{ id: "normal-running", revision: 1, status: "downloading" }]
    } }));
  });
  const privateContext = await browser.newContext();
  await privateContext.route("https://bookmark-fixture.invalid/**", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Private bookmark opened</title>"
  }));
  const page = await privateContext.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}popup.html`);
  assert.equal(await page.evaluate(() => chrome.extension.inIncognitoContext), true);
  await page.locator("#search").fill(bookmark.title);
  const link = page.getByRole("link", { name: /Incognito bookmark fixture/ });
  await link.waitFor();
  const newTab = privateContext.waitForEvent("page");
  await link.click();
  const opened = await newTab;
  await opened.waitForLoadState();
  assert.equal(opened.url(), bookmark.url);
  assert.equal(await opened.title(), "Private bookmark opened");
  assert.equal(opened.context(), privateContext);
  const shared = await page.evaluate(async bookmarkId => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const directory = await getResourceDirectory();
    const library = await openResourceLibrary(directory);
    const record = await library.getBookmark(bookmarkId);
    const file = await library.getFile(record.resources.find(resource => resource.name === "Shared file.bin").id);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await library.attach(bookmarkId, [new File([new Uint8Array(600000).fill(73)], "From incognito.bin", { type: "application/octet-stream" })]);
    await library.setTags(bookmarkId, ["из инкогнито"]);
    window.staleLibrary = library;
    return { name: directory.name, permission: await directory.queryPermission(), tags: record.tags, size: file.size, valid: bytes.every(byte => byte === 42) };
  }, bookmark.id);
  assert.deepEqual(shared, { name: "Resources", permission: "granted", tags: ["общая библиотека"], size: 600000, valid: true });
  const saved = await normal.evaluate(async bookmarkId => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    const record = await library.getBookmark(bookmarkId);
    const resource = record.resources.find(resource => resource.name === "From incognito.bin");
    const bytes = new Uint8Array(await (await library.getFile(resource.id)).arrayBuffer());
    return { count: record.resources.length, tags: record.tags, valid: bytes.length === 600000 && bytes.every(byte => byte === 73) };
  }, bookmark.id);
  assert.deepEqual(saved, { count: 4, tags: ["из инкогнито"], valid: true });
  const sharedCollection = await page.evaluate(async () => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    const collection = await library.createCollection("Из инкогнито");
    const resourceIds = (await library.listResources()).slice(0, 2).map(resource => resource.id);
    await library.addToCollection(collection.id, resourceIds);
    await library.addToCollection(collection.id, resourceIds);
    return { collectionId: collection.id, resourceId: resourceIds[0], resourceIds, count: (await library.listCollections())[0].count };
  });
  assert.equal(sharedCollection.count, 2);
  assert.deepEqual(await normal.evaluate(async collectionId => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    return (await library.listResources({ collectionId })).map(resource => resource.id);
  }, sharedCollection.collectionId), sharedCollection.resourceIds);
  await page.evaluate(async ({ collectionId, resourceIds }) => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    await library.renameCollection(collectionId, "Обновлено из инкогнито");
    await library.removeFromCollection(collectionId, resourceIds);
    if ((await library.listResources({ collectionId })).length !== 0) throw new Error("Membership was not removed");
  }, sharedCollection);
  assert.equal(await normal.evaluate(async collectionId => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    return (await library.listCollections()).find(collection => collection.id === collectionId).name;
  }, sharedCollection.collectionId), "Обновлено из инкогнито");
  await page.evaluate(async ({ collectionId, resourceId }) => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    await library.deleteCollection(collectionId);
    if ((await library.listCollections()).some(collection => collection.id === collectionId)) throw new Error("Collection was not deleted");
    if (!(await library.getFile(resourceId)).size) throw new Error("Deleting a collection must retain the file");
  }, sharedCollection);
  const videoPreview = await page.evaluate(async () => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    const video = (await library.listResources()).find(resource => resource.name === "Shared video.webm");
    const operations = [];
    const listener = changes => {
      for (const [key, change] of Object.entries(changes)) if (key.startsWith("shared-library/") && change.newValue?.request) operations.push(change.newValue.request.operation);
    };
    chrome.storage.onChanged.addListener(listener);
    try {
      const image = await library.getThumbnail(video.id);
      const bitmap = await createImageBitmap(image);
      const width = bitmap.width; bitmap.close();
      const sheet = await library.getTimelapse(video.id);
      const frames = await createImageBitmap(sheet);
      const validFrames = frames.width % 4 === 0 && frames.height % 3 === 0;
      frames.close();
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await sheet.arrayBuffer()))].join(",");
      return { type: image.type, width, readOriginal: operations.includes("getFile"), validFrames, hash };
    } finally { chrome.storage.onChanged.removeListener(listener); }
  });
  assert.equal(videoPreview.type, "image/jpeg");
  assert.equal(videoPreview.width, 640);
  assert.equal(videoPreview.readOriginal, false);
  assert.equal(videoPreview.validFrames, true);
  assert.equal(await normal.evaluate(async () => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    const video = (await library.listResources()).find(resource => resource.name === "Shared video.webm");
    library.getFile = () => { throw new Error("Cached timelapse must not read the original video"); };
    const sheet = await library.getTimelapse(video.id);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await sheet.arrayBuffer()))].join(",");
  }), videoPreview.hash, "Normal and incognito must use the same persisted timelapse");
  await page.locator("#resources-mode").click();
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 4);
  const hoverResource = async name => {
    const card = page.getByRole("button", { name });
    await card.scrollIntoViewIfNeeded();
    // Scrolling deliberately closes hover previews; finish scrolling before moving onto the card.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.move(10, 10);
    await card.hover();
  };
  await hoverResource(/Shared video.webm/);
  await page.waitForFunction(() => document.querySelector(".resource-timelapse")?.dataset.frame !== undefined);
  await page.mouse.move(10, 10);
  await hoverResource(/Shared image.png/);
  await page.waitForFunction(() => document.querySelector(".bookmark-hover-preview img")?.naturalWidth === 640);
  await page.getByRole("button", { name: /Shared image.png/ }).click();
  await page.waitForFunction(() => document.querySelector("#media-content img")?.naturalWidth === 640);
  await page.keyboard.press("Escape");
  await page.goto(`${base}tab.html`);
  await page.waitForFunction(async () => (await chrome.storage.local.get("incognitoDownloadQueue")).incognitoDownloadQueue);
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get("downloadQueue")).downloadQueue.jobs[0].status), "downloading");
  await page.evaluate(async bookmark => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === bookmark.url);
    const canvas = document.createElement("canvas"); canvas.width = 16; canvas.height = 16;
    canvas.getContext("2d").fillRect(0, 0, 16, 16);
    const result = await chrome.runtime.sendMessage({ target: "download-background", type: "start", payload: {
      tabId: tab.id, url: tab.url, title: bookmark.title, bookmarkId: bookmark.id,
      candidate: { kind: "image", url: canvas.toDataURL(), frameId: 0, frameUrl: tab.url, origin: new URL(tab.url).origin }
    } });
    if (!result.ok) throw new Error(result.error);
  }, bookmark);
  await page.locator('.download-job[data-status="done"], .download-job[data-status="error"]').waitFor();
  const downloaded = await page.evaluate(async () => {
    const job = (await chrome.storage.local.get("incognitoDownloadQueue")).incognitoDownloadQueue.jobs.at(-1);
    return { status: job.status, message: job.message };
  });
  assert.equal(downloaded.status, "done", downloaded.message);
  assert.equal(await normal.evaluate(async bookmarkId => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    return (await (await openResourceLibrary(await getResourceDirectory())).getBookmark(bookmarkId)).resources.length;
  }, bookmark.id), 5);
  const concurrent = async (target, name) => target.evaluate(async ({ bookmarkId, name }) => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    await (await openResourceLibrary(await getResourceDirectory())).attach(bookmarkId, [new File([name], name, { type: "text/plain" })]);
  }, { bookmarkId: bookmark.id, name });
  await Promise.all([concurrent(normal, "Concurrent normal.txt"), concurrent(page, "Concurrent private.txt")]);
  assert.deepEqual(await normal.evaluate(async bookmarkId => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    return (await (await openResourceLibrary(await getResourceDirectory())).getBookmark(bookmarkId)).resources.filter(resource => resource.name.startsWith("Concurrent ")).map(resource => resource.name).sort();
  }, bookmark.id), ["Concurrent normal.txt", "Concurrent private.txt"]);
  await page.getByRole("link", { name: "Закладки и ресурсы", exact: true }).click();
  await page.locator("#search").waitFor();
  assert.equal(await page.evaluate(() => chrome.extension.inIncognitoContext), true);
  await normal.goto(`${base}popup.html`);
  const renderCanvas = async target => {
    await target.evaluate(() => localStorage.setItem("viewState", JSON.stringify({ mode: "resources", resourceView: "canvas", resourceScope: "all" })));
    await target.reload();
    await target.locator(".resource-card").first().waitFor();
  };
  await renderCanvas(normal);
  await normal.locator(".resource-card").nth(0).click();
  await normal.locator(".resource-card").nth(1).click();
  const canvasIds = await normal.locator(".canvas-pane").evaluateAll(nodes => nodes.map(node => node.dataset.resourceId));
  assert.equal(canvasIds.length, 2);
  await renderCanvas(page);
  assert.deepEqual(await page.locator(".canvas-pane").evaluateAll(nodes => nodes.map(node => node.dataset.resourceId)), canvasIds, "Native Chrome storage must share canvas state with incognito");
  await page.reload();
  await renderCanvas(page);
  assert.deepEqual(await page.locator(".canvas-pane").evaluateAll(nodes => nodes.map(node => node.dataset.resourceId)), canvasIds);
  await page.goto(`${base}settings.html`);
  await page.waitForFunction(() => document.querySelector("#resource-folder").textContent === "Resources");
  assert.equal(await page.locator("#choose-folder").isDisabled(), true);
  await page.evaluate(async () => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    window.staleLibrary = await openResourceLibrary(await getResourceDirectory());
  });
  await normal.evaluate(async () => {
    const { setResourceDirectory } = await import("./src/resource-directory.js");
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("OtherResources", { create: true });
    await setResourceDirectory(directory);
  });
  assert.match(await page.evaluate(async () => {
    try { await staleLibrary.listResources(); return "Unexpected access"; }
    catch (error) { return error.message; }
  }), /Папка ресурсов изменена/);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#resource-folder").textContent === "OtherResources");
  await normal.close();
  assert.equal(await page.evaluate(async () => {
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    return (await getResourceDirectory()).name;
  }), "OtherResources");
  assert.deepEqual(errors, []);
  console.log("Verified real Chrome extension: private bookmarks, shared folder and SQLite library without setup, reads/uploads across multiple chunks, shared tags, previews, folder changes, closed regular UI and isolated download queues.");
} finally {
  await regular.close();
  assert.equal(dirname(resolve(profile)), root);
  assert.ok(basename(profile).startsWith(".test-incognito-"));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
