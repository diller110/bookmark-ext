import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

async function storeScreenshot(page, name) {
  if (!process.env.STORE_SCREENSHOTS) return;
  await mkdir(process.env.STORE_SCREENSHOTS, { recursive: true });
  const previous = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: join(process.env.STORE_SCREENSHOTS, name + ".png") });
  await page.setViewportSize(previous);
}

// Pass a Playwright module path if it is not installed in the project.
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url)));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("http://localhost:8123/**", async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    const type = { js: "text/javascript", html: "text/html", css: "text/css", svg: "image/svg+xml", wasm: "application/wasm" }[path.split(".").pop()];
    try { await route.fulfill({ body: await readFile(new URL(`../${path}`, import.meta.url)), contentType: type, headers: { "Content-Security-Policy": manifest.content_security_policy.extension_pages } }); }
    catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
  await context.addInitScript(({ manifest }) => {
    const event = { addListener() {} };
    const stored = {};
    const storageListeners = [];
    window.chrome = { storage: { local: {
      get: async key => ({ [key]: stored[key] }),
      set: async values => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          if (JSON.stringify(stored[key]) !== JSON.stringify(value)) changes[key] = { oldValue: stored[key], newValue: value };
        }
        Object.assign(stored, values);
        if (Object.keys(changes).length) for (const listener of storageListeners) listener(changes, "local");
      }
    }, onChanged: { addListener: listener => storageListeners.push(listener) } }, runtime: { getManifest: () => manifest }, bookmarks: {
      getTree: async () => [{ id: "0", title: "", children: [{ id: "1", parentId: "0", title: "Работа", children: [{ id: "2", parentId: "1", title: "Материалы проекта", url: "file:///C:/example" }, { id: "3", parentId: "1", title: "Закладка без ресурсов", url: "file:///C:/empty" }, ...Array.from({length: 30}, (_, index) => ({id: String(100 + index), parentId: "1", title: "Дополнительная закладка " + index, url: "file:///C:/note-" + index}))] }] }],
      onCreated: event, onRemoved: event, onChanged: event, onMoved: event, onChildrenReordered: event, onImportEnded: event
    } };
    FileSystemHandle.prototype.queryPermission = async () => "granted";
    FileSystemHandle.prototype.requestPermission = async () => "granted";
    window.testUrls = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.videoFileReads = 0;
    URL.createObjectURL = blob => { if (blob.type.startsWith("video/")) videoFileReads++; const url = create(blob); testUrls.add(url); return url; };
    URL.revokeObjectURL = url => { testUrls.delete(url); revoke(url); };
  }, { manifest });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://localhost:8123/popup.html");
  await page.evaluate(async () => {
    const { setResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("Resources", { create: true });
    await setResourceDirectory(directory);
    const library = await openResourceLibrary(directory);
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#536b8f"; ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = "#d4be95"; ctx.fillRect(80, 80, 480, 320);
    const png = await new Promise(resolve => canvas.toBlob(resolve));
    const stream = canvas.captureStream(0);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(100);
    for (let frame = 0; frame < 12; frame++) {
      ctx.fillStyle = frame % 2 ? "#44765b" : "#536b8f";
      ctx.fillRect(150, 150, 340, 180);
      stream.getVideoTracks()[0].requestFrame();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    await library.attach("2", [new File([png], "Изображение.png", { type: "image/png" }), new File(chunks, "Видео.webm", { type: "video/webm" }), new File(["notes"], "Заметки.txt", { type: "text/plain" }), new File(["broken"], "Поврежденное.png", { type: "image/png" })]);
    await library.setTags("2", ["проект"]);
  });
  assert.deepEqual(await page.evaluate(async () => (await chrome.storage.local.get("resourceCounts")).resourceCounts), { "2": 4 });
  await page.locator('aside [data-id="1"]').click();
  await page.waitForFunction(() => document.querySelector(".bookmark-resource-count")?.textContent === "4");
  assert.deepEqual((await page.locator(".bookmark-resource-count").allTextContents()).slice(0, 2), ["4", "0"]);
  const bookmarkFilter = page.locator("#bookmark-resource-filter");
  assert.equal(await page.locator(".folder-toolbar").evaluate(node => node.firstElementChild.classList.contains("view-switch") && node.children[1].id === "breadcrumbs"), true, "Tabs must precede the folder path in visual and keyboard order");
  assert.equal(await page.locator("#collections-toggle").evaluate(node => {
    const style = getComputedStyle(node), tab = getComputedStyle(document.querySelector('.view-switch button[aria-pressed="false"]')), capsule = getComputedStyle(document.querySelector(".view-switch")), filter = getComputedStyle(document.querySelector("#bookmark-resource-filter"));
    return style.fontSize === tab.fontSize && style.color === tab.color && style.borderColor === capsule.borderColor && style.borderRadius === capsule.borderRadius && style.backgroundImage === filter.backgroundImage && style.backgroundPosition === filter.backgroundPosition;
  }), true, "Collections must match the tab capsule and use the filter chevron");
  const filterStyle = await bookmarkFilter.evaluate(node => {
    const style = getComputedStyle(node);
    return { image: style.backgroundImage, position: style.backgroundPosition, size: style.backgroundSize };
  });
  assert.ok(filterStyle.image.includes("chevron-down.svg"), "The filter chevron must survive CSS shorthand parsing");
  assert.equal(filterStyle.position, "calc(100% - 8px) calc(50% + 1px)");
  assert.equal(filterStyle.size, "16px 16px");
  assert.equal(await page.evaluate(() => {
    const borders = [...document.querySelectorAll("#bookmark-resource-filter, .resource-filters select, .resource-view-toggle, .view-switch")].map(node => getComputedStyle(node).borderTopColor);
    return new Set(borders).size;
  }), 1, "Resource selectors, view button and tab capsule must share the same border color");
  assert.equal(await bookmarkFilter.evaluate(async node => {
    const image = new Image();
    image.src = getComputedStyle(node).backgroundImage.match(/^url\("(.*)"\)$/)[1];
    await image.decode();
    return image.naturalWidth > 0;
  }), true);
  if (process.env.FILTER_SCREENSHOT) await bookmarkFilter.screenshot({ path: process.env.FILTER_SCREENSHOT });
  await bookmarkFilter.selectOption("with");
  await page.waitForFunction(() => document.querySelector("#bookmarks-mode").textContent === "Закладки (1)");
  assert.equal(await page.locator(".bookmark-row:visible").count(), 1);
  await bookmarkFilter.selectOption("without");
  await page.waitForFunction(() => document.querySelector("#bookmarks-mode").textContent === "Закладки (31)");
  assert.equal(await page.locator(".bookmark-row:visible").count(), 31);
  await page.locator("#search").fill("Материалы проекта");
  await page.waitForFunction(() => document.querySelector("#bookmarks-mode").textContent === "Закладки (0)");
  assert.equal(await page.locator(".bookmark-row:visible").count(), 0);
  assert.equal(await page.locator("#status").isVisible(), true);
  await bookmarkFilter.selectOption("with");
  await page.waitForFunction(() => document.querySelector("#bookmarks-mode").textContent === "Закладки (1)");
  await page.locator("#search").fill("");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#bookmarks-mode").textContent === "Закладки (1)");
  assert.equal(await bookmarkFilter.inputValue(), "with");
  assert.equal(await page.locator(".bookmark-row:visible").count(), 1);
  await bookmarkFilter.selectOption("all");
  await page.waitForFunction(() => document.querySelector("#bookmarks-mode").textContent === "Закладки (32)");
  await page.waitForFunction(() => document.querySelectorAll(".bookmark-resource-thumbnail").length === 3);
  assert.equal(await page.locator(".bookmark-resource-thumbnail").count(), 3);
  assert.equal(await page.locator(".bookmark-resource-more").count(), 1);
  await page.waitForFunction(() => document.querySelector(".bookmark-resource-thumbnail img")?.naturalWidth === 640 && document.querySelector('.bookmark-resource-thumbnail[title="Видео.webm"] img')?.naturalWidth === 640);
  await page.evaluate(async () => {
    const { previewResourceFiles } = await import("./src/resource-browser.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    const resource = (await library.listResources()).find(resource => resource.name === "Изображение.png");
    const image = await library.getFile(resource.id);
    const container = document.createElement("div"); container.id = "parallel-preview-probe";
    container.style.cssText = "display:flex;height:32px";
    document.querySelector("main").prepend(container);
    const entries = new Map();
    for (const id of ["slow", "fast-1", "fast-2"]) {
      const thumbnail = document.createElement("span"); thumbnail.style.cssText = "display:block;width:32px;height:32px";
      container.append(thumbnail); entries.set(thumbnail, { id, mediaType: "image/png" });
    }
    const gate = new Promise(resolve => { window.releaseSlowThumbnail = resolve; });
    window.disposeParallelProbe = previewResourceFiles(container, { getFile: async id => { if (id === "slow") await gate; return image; } }, entries);
  });
  await page.waitForFunction(() => [...document.querySelectorAll("#parallel-preview-probe img")].filter(image => image.naturalWidth === 640).length === 2);
  assert.equal(await page.locator("#parallel-preview-probe > span").first().locator("img").count(), 0, "A slow first thumbnail must not block the next two");
  await page.evaluate(() => { disposeParallelProbe(); releaseSlowThumbnail(); document.querySelector("#parallel-preview-probe").remove(); });
  await page.waitForFunction(() => testUrls.size === 2);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:8123" });
  const copyName = page.locator(".copy-title-button").first();
  await copyName.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Материалы проекта");
  assert.equal(await copyName.getAttribute("aria-label"), "Название скопировано");
  assert.equal(context.pages().length, 1);
  await page.evaluate(() => {
    window.originalClipboardWrite = navigator.clipboard.writeText;
    navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied"); };
  });
  await copyName.click();
  assert.match(await copyName.getAttribute("title"), /Ctrl\+C/);
  assert.equal(await copyName.evaluate(button => button.classList.contains("copied")), false);
  await page.evaluate(() => { navigator.clipboard.writeText = originalClipboardWrite; });
  const titleBox = await page.locator(".bookmark-row .item-title").first().boundingBox();
  await page.mouse.move(titleBox.x + 2, titleBox.y + titleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBox.x + Math.min(150, titleBox.width - 2), titleBox.y + titleBox.height / 2, { steps: 10 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => getSelection().toString().length > 0));
  assert.equal(context.pages().length, 1, "Selecting bookmark text must not open the link");
  await page.evaluate(() => getSelection().removeAllRanges());
  for (const width of [780, 480, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => { const main = document.querySelector("main"); return main.scrollWidth <= main.clientWidth; });
    assert.equal(await page.evaluate(() => {
      const main = document.querySelector("main");
      const toolbar = document.querySelector(".folder-toolbar");
      const cover = getComputedStyle(toolbar, "::before");
      return getComputedStyle(main).paddingTop === "8px" && cover.top === "-8px"
        && cover.height === "8px" && cover.backgroundColor === "rgb(32, 33, 36)";
    }), true, "The folder toolbar must have an 8px top inset covered by an opaque background");
    assert.equal(await page.evaluate(() => {
      const tabs = document.querySelector(".view-switch").getBoundingClientRect();
      const search = document.querySelector(".search").getBoundingClientRect();
      const collections = document.querySelector("#collections-toggle").getBoundingClientRect();
      const actions = document.querySelector(".header-actions").getBoundingClientRect();
      const header = document.querySelector("#app-header");
      const edge = header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight);
      return Math.abs(search.left - tabs.left) < 1 && search.width > 0
        && collections.left >= search.right && collections.left - search.right <= 16
        && Math.abs(collections.top + collections.height / 2 - search.top - search.height / 2) < 1
        && Math.abs(actions.right - edge) < 1
        && [...document.querySelectorAll(".header-actions .expand")].every(node => {
          const box = node.getBoundingClientRect();
          return Math.abs(box.top + box.height / 2 - actions.top - actions.height / 2) < 1;
        });
    }), true, "Search must align with tabs and header actions must align at the right edge and vertical center");
    assert.equal(await page.evaluate(() => {
      const path = document.querySelector("#breadcrumbs").getBoundingClientRect();
      const tabs = document.querySelector(".view-switch").getBoundingClientRect();
      const filter = document.querySelector("#bookmark-resource-filter").getBoundingClientRect();
      return tabs.right <= path.left && path.right <= filter.left
        && Math.abs(path.top + path.height / 2 - tabs.top - tabs.height / 2) < 1
        && Math.abs(filter.top + filter.height / 2 - tabs.top - tabs.height / 2) < 1;
    }), true, "Tabs must stay before the folder path and filter on the same row");
    if (width === 780 && process.env.PATH_SCREENSHOT) await page.screenshot({ path: process.env.PATH_SCREENSHOT });
  }
  assert.equal(await page.locator("#title").count(), 0);
  assert.equal(await page.locator("#count").count(), 0);
  assert.equal(await page.locator("#bookmarks-mode").textContent(), "Закладки (32)");
  assert.equal(await page.locator("#resources-mode").textContent(), "Ресурсы (4)");
  if (process.env.BOOKMARKS_SCREENSHOT) await page.screenshot({ path: process.env.BOOKMARKS_SCREENSHOT });
  await storeScreenshot(page, "bookmarks");
  const hover = page.locator(".bookmark-hover-preview");
  await page.locator('.bookmark-resource-thumbnail[title="Изображение.png"]').hover();
  await page.waitForFunction(() => document.querySelector(".bookmark-hover-preview img")?.naturalWidth === 640);
  assert.equal(await hover.evaluate(node => node.getBoundingClientRect().width > 300), true);
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => !document.querySelector(".bookmark-hover-preview").matches(":popover-open") && testUrls.size === 2);
  await page.locator('.bookmark-resource-thumbnail[title="Видео.webm"]').hover();
  await page.waitForFunction(() => document.querySelector(".resource-timelapse")?.dataset.frame !== undefined);
  const hoverCanvas = hover.locator("canvas");
  const firstFrame = await hoverCanvas.evaluate(canvas => { window.hoverCanvas = canvas; return canvas.dataset.frame; });
  await page.waitForFunction(frame => document.querySelector(".resource-timelapse").dataset.frame !== frame, firstFrame);
  const secondFrame = await hoverCanvas.getAttribute("data-frame");
  await page.waitForFunction(frame => document.querySelector(".resource-timelapse").dataset.frame !== frame, secondFrame);
  assert.ok(await page.evaluate(async () => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    const resource = (await library.listResources()).find(resource => resource.name === "Видео.webm");
    const image = await createImageBitmap(await library.getTimelapse(resource.id));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const colors = new Set();
    for (let frame = 0; frame < 12; frame++) {
      colors.add([...context.getImageData(Math.floor((frame % 4 + 0.5) * image.width / 4), Math.floor((Math.floor(frame / 4) + 0.5) * image.height / 3), 1, 1).data].join(","));
    }
    image.close();
    return colors.size > 1;
  }), "The timelapse cache must contain frames from different moments");
  if (process.env.HOVER_SCREENSHOT) await page.screenshot({ path: process.env.HOVER_SCREENSHOT });
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => testUrls.size === 2 && !hoverCanvas.isConnected);
  await page.setViewportSize({ width: 390, height: 580 });
  await page.locator('.bookmark-resource-thumbnail[title="Изображение.png"]').hover();
  await page.waitForFunction(() => document.querySelector(".bookmark-hover-preview img")?.naturalWidth === 640);
  assert.equal(await hover.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; }), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => testUrls.size === 2);
  await page.locator('.bookmark-resource-thumbnail[title="Изображение.png"]').click();
  await page.waitForFunction(() => document.querySelector("#media-content img")?.naturalWidth === 640);
  assert.equal(await hover.evaluate(node => node.matches(":popover-open")), false);
  assert.equal(await page.locator("#resource-dialog").evaluate(node => node.open), false);
  assert.equal(await page.locator("#media-position").textContent(), "1 из 4");
  assert.equal(await page.locator("#media-previous").isDisabled(), true);
  await page.locator("#media-next").click();
  await page.waitForFunction(() => document.querySelector("#media-content video")?.readyState >= 2);
  await page.locator("#media-content video").evaluate(video => { window.bookmarkVideo = video; return video.play(); });
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("#media-content a")?.download === "Заметки.txt");
  assert.equal(await page.locator("#media-position").textContent(), "3 из 4");
  assert.equal(await page.evaluate(() => bookmarkVideo.paused && !bookmarkVideo.hasAttribute("src")), true);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Скачать файл", exact: true }).click();
  assert.equal((await download).suggestedFilename(), "Заметки.txt");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("#media-content").textContent.includes("Не удалось показать файл"));
  assert.equal(await page.locator("#media-position").textContent(), "4 из 4");
  assert.equal(await page.locator("#media-next").isDisabled(), true);
  await page.getByRole("button", { name: "Закрыть просмотр", exact: true }).click();
  await page.waitForFunction(() => testUrls.size === 2);
  await page.locator('.bookmark-resource-thumbnail[title="Видео.webm"]').click();
  await page.waitForFunction(() => document.querySelector("#media-content video")?.readyState >= 2);
  await page.waitForFunction(() => document.querySelector("#media-content video")?.currentTime > 0);
  assert.equal(await page.locator("#media-content video").evaluate(video => video.autoplay && video.muted && video.loop && !video.paused), true);
  assert.equal(await page.locator("#media-position").textContent(), "2 из 4");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#media-dialog").open && testUrls.size === 2);
  await page.locator('.bookmark-resource-thumbnail[title="Заметки.txt"]').click();
  await page.waitForFunction(() => document.querySelector("#media-content a")?.download === "Заметки.txt");
  assert.equal(await page.locator("#media-position").textContent(), "3 из 4");
  await page.getByRole("button", { name: "Закрыть просмотр", exact: true }).click();
  await page.locator(".bookmark-resource-more").click();
  await page.waitForFunction(() => document.querySelectorAll(".resource-entry").length === 4);
  assert.match(await page.locator(".resource-entry small").first().textContent(), /КБ/);
  await page.getByRole("button", { name: "Закрыть ресурсы", exact: true }).click();
  const iconPreview = await page.evaluate(async () => {
    const { toolbarIcon } = await import("./src/toolbar-icon.js");
    const canvas = new OffscreenCanvas(320, 80);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#202124"; ctx.fillRect(0, 0, 320, 80);
    for (const [index, count] of [null, 0, 4, 25, 120].entries()) {
      const tile = new OffscreenCanvas(48, 48);
      tile.getContext("2d").putImageData(toolbarIcon(count !== null, count, 48), 0, 0);
      ctx.drawImage(tile, 8 + index * 64, 16);
    }
    const blob = await canvas.convertToBlob();
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  if (process.env.TOOLBAR_SCREENSHOT) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(process.env.TOOLBAR_SCREENSHOT, Buffer.from(iconPreview));
  }
  const readsBeforeGrid = await page.evaluate(() => videoFileReads);
  await page.locator("#resources-mode").click();
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 4);
  assert.match(await page.locator(".resource-browser-size").first().textContent(), /КБ/);
  assert.equal(await page.locator("#resources-mode").textContent(), "Ресурсы (4)");
  await page.waitForFunction(() => document.querySelector(".resource-thumbnail img")?.naturalWidth === 640);
  await page.waitForFunction(() => document.querySelector('.resource-card[title="Открыть ресурс: Видео.webm"] img')?.naturalWidth === 640);
  assert.equal(await page.evaluate(() => videoFileReads), readsBeforeGrid, "Cached thumbnails must not open the original video again");
  await page.locator(".resource-preview-error").waitFor();
  const gridUrls = await page.evaluate(() => testUrls.size);
  await page.locator('.resource-card[title="Открыть ресурс: Изображение.png"]').hover();
  await page.waitForFunction(() => document.querySelector(".bookmark-hover-preview img")?.naturalWidth === 640);
  const readsBeforeTimelapse = await page.evaluate(() => videoFileReads);
  await page.locator('.resource-card[title="Открыть ресурс: Видео.webm"]').hover();
  await page.waitForFunction(() => document.querySelector(".resource-timelapse")?.dataset.frame !== undefined);
  const gridFrame = await page.locator(".resource-timelapse").getAttribute("data-frame");
  await page.waitForFunction(frame => document.querySelector(".resource-timelapse").dataset.frame !== frame, gridFrame);
  assert.equal(await page.evaluate(() => videoFileReads), readsBeforeTimelapse, "Repeated hover must animate cached frames without opening the video");
  await page.mouse.move(10, 10);
  await page.waitForFunction(count => testUrls.size === count, gridUrls);
  await page.locator('.resource-card[title="Открыть ресурс: Изображение.png"]').click();
  await page.waitForFunction(() => document.querySelector("#media-content img")?.naturalWidth === 640);
  assert.equal(await context.pages().length, 1);
  assert.equal(await page.locator("#media-dialog").evaluate(node => node.getBoundingClientRect().width > 1000), true);
  assert.equal(await page.locator("#media-dialog").evaluate(node => node.scrollHeight <= node.clientHeight), true);
  assert.equal(await page.locator("#media-set-preview").isVisible(), false);
  assert.equal(await page.locator("#media-position").textContent(), "1 из 3");
  assert.equal(await page.locator("#media-previous").isDisabled(), true);
  await page.getByRole("button", { name: "Следующий ресурс", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#media-content video")?.readyState >= 2);
  await page.locator("#media-content video").evaluate(video => { window.previousVideo = video; return video.play(); });
  await page.locator("#media-content video").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("#media-content").textContent.includes("Не удалось показать файл"));
  assert.equal(await page.locator("#media-title").textContent(), "Поврежденное.png");
  assert.equal(await page.locator("#media-position").textContent(), "3 из 3");
  assert.equal(await page.locator("#media-next").isDisabled(), true);
  assert.equal(await page.evaluate(() => previousVideo.paused && !previousVideo.getAttribute("src")), true);
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#media-position").textContent(), "3 из 3");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector("#media-content video")?.readyState >= 2);
  await page.getByRole("button", { name: "Предыдущий ресурс", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#media-content img")?.naturalWidth === 640);
  await page.evaluate(() => {
    const dialog = document.querySelector("#media-dialog");
    for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "ArrowLeft"]) dialog.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector("#media-content img")?.naturalWidth === 640);
  assert.equal(await page.locator("#media-position").textContent(), "1 из 3");
  assert.equal(await page.evaluate(() => testUrls.size), gridUrls + 1);
  if (process.env.GRID_SCREENSHOT) await page.screenshot({ path: process.env.GRID_SCREENSHOT.replace(/\.png$/, "-viewer.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(count => !document.querySelector("#media-dialog").open && testUrls.size === count, gridUrls);
  await page.locator('.resource-card[title="Открыть ресурс: Видео.webm"]').click();
  await page.waitForFunction(() => document.querySelector("#media-content video")?.readyState >= 2);
  assert.equal(await page.locator("#media-content video").evaluate(video => video.controls), true);
  const selectedPixel = await page.locator("#media-content video").evaluate(async video => {
    video.pause();
    const sought = new Promise(resolve => video.addEventListener("seeked", resolve, { once: true }));
    video.currentTime = 0.65;
    await sought;
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
    const context = canvas.getContext("2d"); context.drawImage(video, 0, 0);
    return [...context.getImageData(320, 240, 1, 1).data];
  });
  await page.getByRole("button", { name: "Сделать кадр превью", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#media-preview-status").textContent === "Кадр сохранён как превью");
  await page.waitForFunction(() => document.querySelector('.resource-card[title="Открыть ресурс: Видео.webm"] img')?.naturalWidth === 640);
  assert.equal(await page.evaluate(async () => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    const video = (await library.listResources()).find(resource => resource.name === "Видео.webm");
    const preview = await library.getPreview(video.id);
    return preview.type === "image/jpeg" && preview.size > 0 && (await library.getFile(video.id)).size === video.size;
  }), true);
  const storedPixel = await page.evaluate(async () => {
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const { getResourceDirectory } = await import("./src/resource-directory.js");
    const library = await openResourceLibrary(await getResourceDirectory());
    const video = (await library.listResources()).find(resource => resource.name === "Видео.webm");
    const image = await createImageBitmap(await library.getPreview(video.id));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); image.close();
    return [...context.getImageData(320, 240, 1, 1).data];
  });
  assert.ok(selectedPixel.every((value, index) => Math.abs(value - storedPixel[index]) < 20), "Preview must contain the selected video frame");
  if (process.env.FRAME_SCREENSHOT) await page.screenshot({ path: process.env.FRAME_SCREENSHOT });
  await page.locator("#media-content video").evaluate(video => video.play());
  await page.getByRole("button", { name: "Закрыть просмотр", exact: true }).click();
  await page.waitForFunction(count => testUrls.size === count && !document.querySelector("#media-content video"), gridUrls);
  await page.locator("#resource-tag-filter").selectOption("проект");
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 4);
  for (const width of [780, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => { const main = document.querySelector("main"); return main.scrollWidth <= main.clientWidth; });
  }
  await page.waitForFunction(() => document.querySelector(".resource-thumbnail img")?.naturalWidth === 640 && document.querySelector('.resource-card[title="Открыть ресурс: Видео.webm"] img')?.naturalWidth === 640 && document.querySelectorAll(".resource-preview-error").length === 1);
  await page.setViewportSize({ width: 780, height: 580 });
  await page.locator('.resource-card[title="Открыть ресурс: Изображение.png"]').scrollIntoViewIfNeeded();
  const scrollTop = await page.locator("main").evaluate(node => node.scrollTop);
  await page.locator('.resource-card[title="Открыть ресурс: Изображение.png"]').click();
  await page.waitForFunction(() => document.querySelector("#media-content img")?.naturalWidth === 640);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("main").evaluate(node => node.scrollTop), scrollTop);
  await page.setViewportSize({ width: 1280, height: 900 });
  if (process.env.GRID_SCREENSHOT) await page.screenshot({ path: process.env.GRID_SCREENSHOT });
  await storeScreenshot(page, "resources");
  await page.locator("#search").fill("Изображение.png");
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 1);
  assert.equal(await page.locator("#resources-mode").textContent(), "Ресурсы (1)");
  await page.locator(".resource-card").click();
  await page.waitForFunction(() => document.querySelector("#media-content img")?.naturalWidth === 640);
  assert.equal(await page.locator("#media-position").textContent(), "1 из 1");
  assert.equal(await page.locator("#media-next").isDisabled(), true);
  assert.equal(await page.locator("#media-previous").isDisabled(), true);
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#media-position").textContent(), "1 из 1");
  await page.keyboard.press("Escape");
  await page.locator("#search").fill("");
  await page.locator("#bookmarks-mode").click();
  await page.waitForFunction(() => testUrls.size === 2 && document.querySelector(".bookmark-resource-thumbnail img")?.naturalWidth === 640 && document.querySelector('.bookmark-resource-thumbnail[title="Видео.webm"] img')?.naturalWidth === 640);
  assert.equal(await page.locator(".resource-card").count(), 0);
  await page.locator("main").evaluate(node => { node.scrollTop = 600; });
  const bookmarkScroll = await page.locator("main").evaluate(node => node.scrollTop);
  assert.ok(bookmarkScroll > 0);
  await page.evaluate(async () => {
    const { getResourceDirectory, setResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const original = await getResourceDirectory();
    const oldLibrary = await openResourceLibrary(original);
    const another = await (await navigator.storage.getDirectory()).getDirectoryHandle("OtherResources", { create: true });
    const newLibrary = await openResourceLibrary(another);
    await newLibrary.sync();
    if ((await chrome.storage.local.get("resourceCounts")).resourceCounts["2"] !== 4) throw new Error("Unselected library changed the toolbar count");
    await setResourceDirectory(another);
    if (Object.keys((await chrome.storage.local.get("resourceCounts")).resourceCounts).length) throw new Error("Old counts survived a directory change");
    await newLibrary.attach("2", [new File(["new"], "new.txt", { type: "text/plain" })]);
    await oldLibrary.sync();
    if ((await chrome.storage.local.get("resourceCounts")).resourceCounts["2"] !== 1) throw new Error("Previous library overwrote the new count");
  });
  await page.waitForFunction(() => document.querySelector(".bookmark-resource-count")?.textContent === "1");
  assert.equal(await page.locator("#resources-mode").textContent(), "Ресурсы (0)", "The selected tag still filters the new library");
  assert.equal(await page.locator(".bookmark-resource-thumbnail").count(), 1);
  assert.equal(await page.locator("main").evaluate(node => node.scrollTop), bookmarkScroll);
  assert.equal(await page.locator(".bookmark-resource-more").count(), 0);
  await page.waitForFunction(() => testUrls.size === 0);
  await page.evaluate(async () => {
    const { setResourceDirectory } = await import("./src/resource-directory.js");
    const { openResourceLibrary } = await import("./src/resource-library.js");
    const original = await (await navigator.storage.getDirectory()).getDirectoryHandle("Resources");
    await setResourceDirectory(original);
    const oldLibrary = await openResourceLibrary(original);
    await oldLibrary.sync();
    if ((await chrome.storage.local.get("resourceCounts")).resourceCounts["2"] !== 4) throw new Error("Existing catalog did not restore its count");
  });
  await page.waitForFunction(() => document.querySelector(".bookmark-resource-count")?.textContent === "4" && document.querySelectorAll(".bookmark-resource-thumbnail").length === 3);
  await page.reload();
  await page.locator('.bookmark-resource-thumbnail[title="Видео.webm"]').hover();
  await page.waitForFunction(() => document.querySelector(".resource-timelapse")?.dataset.frame !== undefined);
  assert.equal(await page.evaluate(() => videoFileReads), 0, "Timelapse cache must survive reopening the extension");
  await page.locator("#collections-toggle").click();
  await page.locator("#collections-menu").getByRole("menuitem", { name: "+ Добавить новую подборку", exact: true }).click();
  await page.locator("#collection-name").fill("Референсы");
  await page.locator("#collection-save").click();
  await page.waitForFunction(() => document.querySelector(".collection-path")?.textContent === "Референсы" && document.querySelector("#resource-mode-count").textContent === "0");
  await page.locator('aside [data-id="1"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 4);
  const imageCard = page.locator(".resource-card").filter({ hasText: "Изображение.png" });
  for (let repeat = 0; repeat < 2; repeat++) {
    await imageCard.click({ button: "right" });
    await page.locator("#resource-context-menu").getByRole("menuitem", { name: "Добавить в подборку…", exact: true }).click();
    await page.locator("#resource-context-menu").getByRole("menuitem", { name: "Референсы", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#resource-context-menu").matches(":popover-open"));
    assert.equal(await page.locator("#collection-toast").textContent(), "Добавлено в подборку «Референсы»");
    assert.equal(await page.locator("#collection-toast").evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.matches(":popover-open") && Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 1 && innerHeight - rect.bottom === 20;
    }), true);
  }
  await page.locator("#collections-toggle").click();
  await page.locator("#collections-menu").getByRole("menuitem", { name: "Референсы (1)", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".collection-path")?.textContent === "Референсы" && document.querySelectorAll(".resource-card").length === 1);
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".collection-path")?.textContent === "Референсы" && document.querySelectorAll(".resource-card").length === 1);
  await page.locator("#search").fill("missing resource");
  await page.waitForFunction(() => document.querySelector("#resource-mode-count").textContent === "0");
  await page.locator("#search").fill("");
  await page.waitForFunction(() => document.querySelector("#resource-mode-count").textContent === "1");
  await page.locator(".resource-card").click({ button: "right" });
  await page.locator("#resource-context-menu").getByRole("menuitem", { name: "Добавить в подборку…", exact: true }).click();
  await page.locator("#resource-context-menu").getByRole("menuitem", { name: "+ Добавить новую подборку", exact: true }).click();
  await page.locator("#collection-name").fill("Ещё одна");
  await page.locator("#collection-save").click();
  await page.waitForFunction(() => !document.querySelector("#collection-dialog").open);
  await page.locator("#collections-toggle").click();
  await page.locator("#collections-menu").getByRole("menuitem", { name: "Ещё одна (1)", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".collection-path")?.textContent === "Ещё одна" && document.querySelectorAll(".resource-card").length === 1);
  await page.locator(".resource-card").click({ button: "right" });
  await page.locator("#resource-context-menu").getByRole("menuitem", { name: "Убрать из подборки", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 0 && document.querySelector("#resource-mode-count").textContent === "0");
  await page.locator("#collections-toggle").click();
  await page.locator("#collections-menu").getByRole("menuitem", { name: "Референсы (1)", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 1);
  await page.locator("#collections-toggle").click();
  await page.locator("#collections-menu").getByRole("menuitem", { name: "Действия с подборкой «Референсы»", exact: true }).click();
  await page.locator("#collections-menu").getByRole("menuitem", { name: "Переименовать", exact: true }).click();
  assert.equal(await page.locator("#collection-name").inputValue(), "Референсы");
  await page.locator("#collection-name").fill("Переименованная");
  await page.locator("#collection-save").click();
  await page.waitForFunction(() => document.querySelector(".collection-path")?.textContent === "Переименованная");
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".collection-path")?.textContent === "Переименованная" && document.querySelectorAll(".resource-card").length === 1);
  await page.locator("#collections-toggle").click();
  await page.locator("#collections-menu").getByRole("menuitem", { name: "Действия с подборкой «Переименованная»", exact: true }).click();
  await page.locator("#collections-menu").getByRole("menuitem", { name: "Удалить подборку", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".collection-path") && document.querySelectorAll(".resource-card").length === 4);
  assert.equal(await page.locator("#collection-toast").textContent(), "Подборка «Переименованная» удалена");
  await page.waitForFunction(() => !document.querySelector("#collection-toast").matches(":popover-open"));
  await page.locator("#collections-toggle").click();
  assert.equal(await page.locator("#collections-menu").getByRole("menuitem", { name: "Переименованная (1)", exact: true }).count(), 0);
  await page.locator("#collections-menu").getByRole("menuitem", { name: "Ещё одна (0)", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const cards = page.locator(".resource-card");
  const checks = page.locator(".resource-select");
  await checks.nth(0).check();
  await cards.nth(3).click({ modifiers: ["Shift"] });
  assert.equal(await page.locator(".resource-select:checked").count(), 4);
  assert.equal(await page.locator("#media-dialog").evaluate(node => node.open), false);
  await cards.nth(2).click({ modifiers: ["Control"] });
  assert.equal(await page.locator(".resource-select:checked").count(), 3);
  await page.locator("#resource-clear-selection").click();
  assert.equal(await page.locator(".resource-select:checked").count(), 0);
  await checks.nth(0).check();
  await checks.nth(1).check();
  assert.equal(await page.locator("#resource-selected-count").textContent(), "Выбрано: 2");
  await cards.nth(0).click({ button: "right" });
  await page.locator("#resource-context-menu").getByRole("menuitem", { name: "Добавить выбранные в подборку… (2)", exact: true }).click();
  await page.locator("#resource-context-menu").getByRole("menuitem", { name: "Ещё одна", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#resource-context-menu").matches(":popover-open"));
  assert.equal(await page.locator("#collection-toast").textContent(), "Добавлено в подборку «Ещё одна»: 2");
  await page.locator("#collections-toggle").click();
  await page.locator("#collections-menu").getByRole("menuitem", { name: "Ещё одна (2)", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 2);
  await page.locator(".resource-select").first().check();
  await page.locator("#resource-select-all").click();
  assert.equal(await page.locator(".resource-select:checked").count(), 2);
  await page.locator(".resource-card").first().click({ button: "right" });
  await page.locator("#resource-context-menu").getByRole("menuitem", { name: "Убрать выбранные из подборки (2)", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 0 && document.querySelector("#resource-mode-count").textContent === "0");
  await page.locator('aside [data-id="1"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 4);
  await page.locator(".resource-select").first().check();
  await page.locator(".resource-card").first().focus();
  await page.keyboard.press("Control+a");
  assert.equal(await page.locator(".resource-select:checked").count(), 4);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".resource-select:checked").count(), 0);
  await page.locator("#resource-view-toggle").click();
  await page.locator("#resource-view-menu").getByRole("button", { name: "Просмотр", exact: true }).click();
  await page.locator(".resource-card").filter({ hasText: "Видео.webm" }).hover();
  await page.waitForFunction(() => document.querySelector(".bookmark-hover-preview .resource-timelapse")?.dataset.frame !== undefined);
  await page.mouse.move(600, 300);
  assert.equal(await page.locator(".bookmark-hover-preview").evaluate(node => node.matches(":popover-open")), false);
  await page.locator(".resource-card").filter({ hasText: "Видео.webm" }).click();
  await page.waitForFunction(() => document.querySelector(".canvas-pane video")?.readyState >= 2);
  await page.locator(".canvas-pane video").evaluate(video => { window.canvasVideo = video; });
  await page.waitForFunction(() => canvasVideo.currentTime > 0);
  assert.equal(await page.evaluate(() => canvasVideo.autoplay && canvasVideo.muted && canvasVideo.loop && !canvasVideo.paused), true);
  assert.deepEqual(await page.evaluate(() => {
    const time = canvasVideo.currentTime;
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    return { sameVideo: document.querySelector(".canvas-pane video") === canvasVideo, playing: !canvasVideo.paused, retainedTime: canvasVideo.currentTime >= time };
  }), { sameVideo: true, playing: true, retainedTime: true }, "Returning focus must keep the same playing video and playback position");
  await page.locator(".resource-card").filter({ hasText: "Изображение.png" }).click();
  const imagePane = page.locator(".canvas-pane:has(img)");
  const imageRect = await imagePane.boundingBox();
  const originalVideoUrl = await page.evaluate(() => canvasVideo.src);
  await page.locator(".canvas-pane:has(video)").dragTo(imagePane, { sourcePosition: { x: 20, y: 20 }, targetPosition: { x: Math.round(imageRect.width / 2), y: Math.round(imageRect.height - 8) } });
  assert.equal(await page.locator("#resource-canvas").getAttribute("data-axis"), "vertical");
  assert.equal(await page.locator(".canvas-pane").count(), 2);
  assert.equal(await page.locator(".canvas-pane").last().locator("video").count(), 1, "Moving an existing video below another resource must create a second row");
  await page.waitForFunction(() => !canvasVideo.paused);
  assert.equal(await page.evaluate(() => document.querySelector(".canvas-pane video") === canvasVideo && canvasVideo.src), originalVideoUrl, "Moving must reuse the video without loading the file again");
  const rowHandle = await page.getByRole("separator", { name: "Высота строк", exact: true }).boundingBox();
  const oldImageHeight = (await imagePane.boundingBox()).height;
  await page.mouse.move(rowHandle.x + rowHandle.width / 2, rowHandle.y + rowHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowHandle.x + rowHandle.width / 2, rowHandle.y + rowHandle.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  assert.ok((await imagePane.boundingBox()).height > oldImageHeight + 50);
  assert.equal(await page.evaluate(() => document.querySelector(".canvas-pane video") === canvasVideo && canvasVideo.src === canvasVideo.getAttribute("src") && !canvasVideo.paused), true, "Resizing a playing video must keep its live player intact");
  await page.locator(".canvas-pane:has(video)").hover();
  await page.getByRole("button", { name: "Убрать с полотна: Видео.webm", exact: true }).click();
  assert.equal(await page.evaluate(() => canvasVideo.paused && !canvasVideo.hasAttribute("src")), true);
  assert.deepEqual(errors, []);
  console.log("Verified grid/viewer, navigation, toolbar drawing, published SQLite resource counts, directory changes, collection creation/selection, resource context menus, duplicate membership prevention and persisted collection views.");
} finally { await browser.close(); }
