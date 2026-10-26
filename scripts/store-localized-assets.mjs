import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { supportedLocales } from "./locales.mjs";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const labels = {
  ru: ["Дизайн", "Референсы", "Анимация", "Исследования"], en: ["Design", "References", "Motion", "Research"],
  es: ["Diseño", "Referencias", "Animación", "Investigación"], pt_BR: ["Design", "Referências", "Animação", "Pesquisa"],
  fr: ["Design", "Références", "Animation", "Recherche"], de: ["Design", "Referenzen", "Animation", "Recherche"],
  it: ["Design", "Riferimenti", "Animazione", "Ricerca"], zh_CN: ["设计", "参考资料", "动画", "研究"],
  ja: ["デザイン", "参考資料", "アニメーション", "リサーチ"], ko: ["디자인", "참고 자료", "애니메이션", "리서치"],
  ar: ["التصميم", "المراجع", "الحركة", "البحث"], hi: ["डिज़ाइन", "संदर्भ", "एनीमेशन", "शोध"]
};

for (const locale of supportedLocales) {
  const profile = await mkdtemp(join(root, ".test-incognito-store-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome", headless: true, locale: locale.replace("_", "-"), viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging", `--lang=${locale.replace("_", "-")}`]
  });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: root });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.evaluate(async names => {
      const folder = await chrome.bookmarks.create({ title: names[0] });
      const references = await chrome.bookmarks.create({ parentId: folder.id, title: names[1], url: "https://example.com/references" });
      await chrome.bookmarks.create({ parentId: folder.id, title: names[2], url: "https://example.com/motion" });
      await chrome.bookmarks.create({ parentId: folder.id, title: names[3], url: "https://example.com/research" });
      const { setResourceDirectory } = await import("./src/resource-directory.js");
      const { openResourceLibrary } = await import("./src/resource-library.js");
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("DemoResources", { create: true });
      await setResourceDirectory(directory);
      const library = await openResourceLibrary(directory);
      const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 640;
      const ctx = canvas.getContext("2d");
      const draw = index => {
        const colors = [["#e9dfd0", "#c86948", "#354c59"], ["#bccac0", "#eee6d8", "#354a45"], ["#d6d6df", "#e8bc7b", "#4b4b68"]][index % 3];
        ctx.fillStyle = colors[0]; ctx.fillRect(0, 0, 960, 640);
        ctx.fillStyle = colors[1]; ctx.beginPath(); ctx.arc(620, 225, 140, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = colors[2]; ctx.beginPath(); ctx.moveTo(0, 640); ctx.lineTo(0, 460); ctx.lineTo(330, 190 + index * 35); ctx.lineTo(720, 640); ctx.fill();
        ctx.fillStyle = colors[1]; ctx.beginPath(); ctx.moveTo(430, 640); ctx.lineTo(770, 370); ctx.lineTo(960, 480); ctx.lineTo(960, 640); ctx.fill();
      };
      const files = [];
      for (let index = 0; index < 3; index++) {
        draw(index);
        files.push(new File([await new Promise(resolve => canvas.toBlob(resolve))], `Study-${index + 1}.png`, { type: "image/png" }));
      }
      const stream = canvas.captureStream(0);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      const chunks = []; recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start(100);
      for (let frame = 0; frame < 8; frame++) {
        draw(frame % 3); stream.getVideoTracks()[0].requestFrame();
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
      files.push(new File(chunks, "Motion-study.webm", { type: "video/webm" }));
      await library.attach(references.id, files);
      const video = (await library.getBookmark(references.id)).resources.find(resource => resource.mediaType.startsWith("video/"));
      const frame = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
      await library.setPreview(video.id, new File([frame], "preview.jpg", { type: "image/jpeg" }));
      await library.setTags(references.id, [names[0], names[1]]);
      localStorage.setItem("viewState", JSON.stringify({ selectedId: folder.id, expandedIds: ["0", folder.parentId, folder.id], mode: "bookmarks" }));
    }, labels[locale]);
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".bookmark-resource-count")?.textContent === "4");
    await page.waitForFunction(() => [...document.querySelectorAll(".bookmark-resource-thumbnail img")].filter(image => image.complete && image.naturalWidth > 0).length >= 2);
    const target = join(root, "release", "store-assets", locale);
    await mkdir(target, { recursive: true });
    const capture = async name => {
      const bytes = await page.screenshot({ path: join(target, name + ".png") });
      assert.equal(bytes.readUInt32BE(16), 1280); assert.equal(bytes.readUInt32BE(20), 800);
      assert.equal(bytes[25], 2, "Store PNGs must have RGB pixels without alpha");
    };
    await capture("bookmarks");
    await page.locator("#resources-mode").click();
    await page.waitForFunction(() => document.querySelectorAll(".resource-card").length === 4);
    await page.waitForFunction(() => [...document.querySelectorAll(".resource-thumbnail img")].filter(image => image.complete && image.naturalWidth > 0).length === 4);
    await capture("resources");
    await page.locator("#resource-view-toggle").click();
    await page.locator('[data-resource-view="canvas"]').click();
    await page.locator(".resource-card").nth(0).click();
    await page.locator(".resource-card").nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll(".canvas-pane img").length === 2 && [...document.querySelectorAll(".canvas-pane img")].every(image => image.complete && image.naturalWidth > 0));
    await capture("canvas");
    assert.deepEqual(errors, []);
    console.log(`Created ${locale}: bookmarks, resources and canvas (1280×800 RGB), anonymous demo data.`);
  } finally {
    await context.close();
    assert.equal(dirname(resolve(profile)), root);
    assert.ok(basename(profile).startsWith(".test-incognito-store-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
