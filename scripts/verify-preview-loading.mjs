import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.route("http://localhost:8123/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") return route.fulfill({ contentType: "text/html", body: (await readFile(new URL("../popup.html", import.meta.url), "utf8")).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*>/g, "") });
    return route.fulfill({ contentType: "text/javascript", body: await readFile(new URL(`..${pathname}`, import.meta.url)) });
  });
  await page.goto("http://localhost:8123/");
  await page.evaluate(async () => {
    const { previewResourceFiles } = await import("./src/resource-browser.js");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 16;
    const image = await new Promise(resolve => canvas.toBlob(resolve));
    const items = document.querySelector("#items");
    items.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
    const entries = new Map();
    for (let index = 0; index < 9; index++) {
      const node = document.createElement("li");
      node.id = `resource-${index}`;
      node.style.cssText = "display:block;width:90px;height:90px";
      items.append(node); entries.set(node, { id: index, mediaType: "video/mp4" });
    }
    window.generating = [];
    window.releaseGeneration = [];
    window.readOriginals = 0;
    window.disposePreviews = previewResourceFiles(items, {
      getPreview: async id => id < 3 ? null : image,
      getThumbnail: id => { window.generating.push(id); return new Promise(resolve => window.releaseGeneration.push(() => resolve(image))); },
      getFile: async () => { window.readOriginals++; throw new Error("Cached thumbnails must not read videos"); }
    }, entries);
  });
  await page.waitForFunction(() => window.generating.length === 3 && document.querySelectorAll("img").length === 6);
  assert.equal(await page.locator("#resource-0 img").count(), 0);
  assert.equal(await page.locator("#resource-8 img").count(), 1);
  assert.equal(await page.evaluate(() => window.readOriginals), 0);
  await page.evaluate(() => window.releaseGeneration.forEach(release => release()));
  await page.waitForFunction(() => document.querySelectorAll("img").length === 9 && [...document.images].every(image => image.naturalWidth === 16));
  await page.evaluate(() => window.disposePreviews());
  assert.equal(await page.locator("#items img").count(), 0);
  const worker = await browser.newPage();
  await worker.route("http://localhost:8124/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    const modules = {
      "/src/resource-directory.js": 'export async function getDownloadDirectory(id) { return {id,directory:{}}; }',
      "/src/resource-library.js": 'export async function openResourceLibrary() { return window.testLibrary; }',
      "/src/extension-bridge.js": 'export async function downloadCall(type) { if(type === "release") window.released++; }'
    };
    return route.fulfill({ contentType: pathname === "/" ? "text/html" : "text/javascript", body: pathname === "/" ? "<!doctype html>" : modules[pathname] || await readFile(new URL(`..${pathname}`, import.meta.url)) });
  });
  await worker.goto("http://localhost:8124/");
  await worker.evaluate(async () => {
    window.thumbnails = []; window.timelapses = []; window.released = 0;
    window.testLibrary = {
      getThumbnail: id => new Promise(resolve => window.thumbnails.push({ id, resolve })),
      getTimelapse: id => new Promise((resolve, reject) => window.timelapses.push({ id, resolve, reject }))
    };
    const queue = await import("./src/preview-queue.js");
    window.previewQueue = queue;
    queue.enqueuePreviews({ id: "fixture", resourceIds: [0, 1, 2, 3, 4] });
  });
  await worker.waitForFunction(() => window.thumbnails.length === 3);
  assert.equal(await worker.evaluate(() => window.previewQueue.previewsPending()), true);
  await worker.evaluate(() => window.thumbnails[0].resolve());
  await worker.waitForFunction(() => window.thumbnails.length === 4 && window.timelapses.length === 1);
  await worker.evaluate(() => window.thumbnails.slice(1).forEach(job => job.resolve()));
  await worker.waitForFunction(() => window.thumbnails.length === 5);
  await worker.evaluate(() => window.thumbnails[4].resolve());
  assert.equal(await worker.evaluate(() => window.timelapses.length), 1);
  await worker.evaluate(() => window.timelapses[0].reject(new Error("Unsupported video")));
  for (let index = 1; index < 5; index++) {
    await worker.waitForFunction(index => window.timelapses.length === index + 1, index);
    await worker.evaluate(index => window.timelapses[index].resolve(), index);
  }
  await worker.waitForFunction(() => !window.previewQueue.previewsPending() && window.released === 1);
  console.log("Verified six cached video previews display while three uncached previews are still generating; generation runs concurrently and cached previews never read original videos.");
  console.log("Verified background thumbnails run three at a time without waiting for timelapses, errors do not block the queue, and the worker releases only after both queues finish.");
} finally { await browser.close(); }
