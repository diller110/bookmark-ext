import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const errors = [];
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  await context.addInitScript(() => {
    window.chrome = { extension: { getViews: () => location.search.includes("regular") ? [] : [window] } };
  });
  await context.route("http://localhost:8123/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body = await readFile(new URL(`..${path}`, import.meta.url));
    if (path.endsWith(".html")) body = body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, script => script.includes('src="src/popup-size.js"') ? script : "");
    return route.fulfill({ body, contentType: path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript" });
  });
  let page = await context.newPage();
  const origin = "http://localhost:8123/";
  await page.goto(`${origin}tab.html`);
  const dimensions = () => page.locator("body").evaluate(body => ({ width: body.offsetWidth, height: body.offsetHeight }));
  assert.deepEqual(await dimensions(), { width: 780, height: 580 });
  assert.equal(await page.locator("body").evaluate(body => getComputedStyle(body).borderRadius), "18px");
  const grip = page.getByRole("button", { name: "Изменить размер окна", exact: true });
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 80, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await dimensions(), { width: 680, height: 500 });
  await grip.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(await dimensions(), { width: 700, height: 520 });
  await page.close();
  page = await context.newPage();
  for (const file of ["tab.html", "popup.html?from=tab", "settings.html?from=tab"]) {
    await page.goto(`${origin}${file}`);
    await page.setViewportSize({ width: 700, height: 520 });
    assert.deepEqual(await dimensions(), { width: 700, height: 520 });
    assert.equal(await page.locator(".popup-size-bar").count(), 1);
    assert.equal(await page.locator("body").evaluate(body => body.scrollWidth <= body.clientWidth), true);
    assert.equal(await page.locator("footer").evaluate(footer => Math.abs(footer.getBoundingClientRect().bottom - document.body.getBoundingClientRect().bottom + 1) < 1), true);
  }
  await page.evaluate(() => localStorage.setItem("popupSize", '{"width":9999,"height":9999}'));
  await page.goto(`${origin}tab.html`);
  assert.deepEqual(await dimensions(), { width: 800, height: 600 });
  await page.evaluate(() => localStorage.setItem("popupSize", '{"width":1,"height":1}'));
  await page.reload();
  assert.deepEqual(await dimensions(), { width: 480, height: 360 });
  await page.evaluate(() => localStorage.setItem("popupSize", "broken"));
  await page.reload();
  assert.deepEqual(await dimensions(), { width: 780, height: 580 });
  if (process.env.POPUP_SCREENSHOT) {
    await page.setViewportSize({ width: 780, height: 580 });
    await page.screenshot({ path: process.env.POPUP_SCREENSHOT });
  }
  await page.goto(`${origin}tab.html?regular`);
  assert.equal(await page.locator(".popup-size-bar").count(), 0);
  assert.equal(await page.locator("body").evaluate(body => body.style.width), "");
  assert.deepEqual(errors, []);
  console.log("Verified pointer and keyboard resizing, rounded popup frame, saved size across reopening/navigation, Chrome limits, malformed storage and normal-tab behavior. Chrome popup detection is simulated; layout and pointer capture use real Chrome.");
} finally { await browser.close(); }
