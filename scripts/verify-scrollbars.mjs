import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.route("http://localhost:8123/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><link rel="stylesheet" href="/src/style.css"><script type="module" src="/src/scrollbars.js"></script>
      <style>body{gap:12px}body>div,body>main{flex:none;padding:0;border:0;width:220px;height:140px;overflow:auto}#vertical>div{height:900px}#vertical{overflow:auto}dialog{width:300px;height:200px;overflow:auto}dialog>div{height:1200px}#horizontal>div{width:900px;height:40px}#both>div{width:900px;height:900px}</style>
      <main id="vertical"><div></div></main><div id="horizontal"><div></div></div><div id="both"><div></div></div><dialog id="modal"><div></div></dialog>` });
    return route.fulfill({ contentType: pathname.endsWith("css") ? "text/css" : "text/javascript", body: await readFile(new URL(`..${pathname}`, import.meta.url)) });
  });
  await page.goto("http://localhost:8123/");
  await page.mouse.move(900, 700);
  const verticalBar = page.locator('.overlay-scrollbar[aria-controls="vertical"][aria-orientation="vertical"]');
  const horizontalBar = page.locator('.overlay-scrollbar[aria-controls="horizontal"][aria-orientation="horizontal"]');
  await verticalBar.waitFor({ state: "attached" });
  for (const id of ["vertical", "horizontal", "both"]) {
    const geometry = await page.locator('#' + id).evaluate(node => ({
      width: node.offsetWidth - node.clientWidth,
      height: node.offsetHeight - node.clientHeight,
      native: getComputedStyle(node, "::-webkit-scrollbar").width
    }));
    assert.deepEqual(geometry, { width: 0, height: 0, native: "0px" }, "Scrollbars must reserve zero layout space");
  }
  await page.evaluate(() => {
    window.opacities = [];
    const start = performance.now();
    const record = () => {
      const bar = document.querySelector('.overlay-scrollbar[aria-controls="vertical"]');
      opacities.push(Number(getComputedStyle(bar).opacity));
      if (performance.now() - start < 350) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  });
  await page.locator("#vertical").hover();
  await page.waitForFunction(() => opacities.length > 12);
  assert.equal(await page.evaluate(() => opacities.some(opacity => opacity > 0 && opacity < 1)), true);
  const owner = await page.locator("#vertical").boundingBox();
  const barBox = await verticalBar.boundingBox();
  assert.ok(Math.abs(owner.x + owner.width - barBox.x - barBox.width) < 1);
  assert.equal(barBox.width, 6);
  const thumb = verticalBar.locator(".overlay-scrollbar-thumb");
  const thumbBox = await thumb.boundingBox();
  await page.mouse.move(thumbBox.x + 3, thumbBox.y + 8);
  await page.mouse.down(); await page.mouse.move(thumbBox.x + 3, thumbBox.y + 65, {steps: 5}); await page.mouse.up();
  assert.ok(await page.locator("#vertical").evaluate(node => node.scrollTop > 150));
  await horizontalBar.focus();
  await page.keyboard.press("End");
  assert.ok(await page.locator("#horizontal").evaluate(node => node.scrollLeft >= node.scrollWidth - node.clientWidth));
  await page.locator("#both").evaluate(node => { node.scrollTop = 80; node.scrollLeft = 80; });
  await page.waitForFunction(() => document.querySelector('.overlay-scrollbar[aria-controls="both"]').classList.contains("is-visible"));
  await page.locator('.overlay-scrollbar[aria-controls="both"][aria-orientation="horizontal"]').hover();
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(() => document.querySelector("#both").scrollLeft > 80);
  assert.equal(await page.locator("#both").evaluate(node => node.scrollTop), 80, "Wheel on the horizontal overlay must not also scroll vertically");
  await page.mouse.move(900, 700);
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.overlay-scrollbar[aria-controls="both"]')).opacity === "0");
  await page.locator("#horizontal").evaluate(node => { node.style.direction = "rtl"; node.scrollLeft = 0; });
  await horizontalBar.focus();
  const maximum = await page.locator("#horizontal").evaluate(node => node.scrollWidth - node.clientWidth);
  await page.waitForFunction(maximum => Number(document.querySelector('.overlay-scrollbar[aria-controls="horizontal"]').getAttribute("aria-valuenow")) === maximum, maximum);
  await page.keyboard.press("Home");
  assert.equal(await page.locator("#horizontal").evaluate(node => node.scrollLeft), -maximum, "RTL Home reaches the physical left edge");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#horizontal").evaluate(node => node.scrollLeft), -maximum + 40);
  await page.keyboard.press("End");
  assert.equal(await page.locator("#horizontal").evaluate(node => node.scrollLeft), 0, "RTL End reaches the physical right edge");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.locator("#horizontal").evaluate(node => node.scrollLeft), -40);
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector('.overlay-scrollbar[aria-controls="horizontal"]').getAttribute("aria-valuenow") === "0");
  const rtlThumb = await horizontalBar.locator(".overlay-scrollbar-thumb").boundingBox();
  const rtlTrack = await horizontalBar.boundingBox();
  assert.ok(Math.abs(rtlThumb.x - rtlTrack.x) < 1, "RTL thumb begins at the physical left edge");
  await page.mouse.move(rtlThumb.x + 8, rtlThumb.y + 3); await page.mouse.down();
  await page.mouse.move(rtlThumb.x + 108, rtlThumb.y + 3, { steps: 5 }); await page.mouse.up();
  const rtlOffset = await page.locator("#horizontal").evaluate(node => node.scrollLeft);
  assert.ok(rtlOffset > -maximum && rtlOffset < 0, "Dragging the RTL thumb reaches intermediate content");
  await page.waitForFunction(expected => Number(document.querySelector('.overlay-scrollbar[aria-controls="horizontal"]').getAttribute("aria-valuenow")) === expected, Math.round(rtlOffset + maximum));
  await horizontalBar.focus(); await page.keyboard.press("End");
  await page.waitForFunction(maximum => Number(document.querySelector('.overlay-scrollbar[aria-controls="horizontal"]').getAttribute("aria-valuenow")) === maximum, maximum);
  const rtlEndThumb = await horizontalBar.locator(".overlay-scrollbar-thumb").boundingBox();
  assert.ok(Math.abs(rtlEndThumb.x + rtlEndThumb.width - rtlTrack.x - rtlTrack.width) < 1, "RTL thumb ends at the physical right edge");
  await page.evaluate(() => document.querySelector("#modal").showModal());
  const modalBar = page.locator('.overlay-scrollbar[aria-controls="modal"][aria-orientation="vertical"]');
  await modalBar.waitFor({state:"attached"});
  await page.locator("#modal").hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.overlay-scrollbar[aria-controls="modal"]')).opacity === "1");
  const modalThumb = await modalBar.locator(".overlay-scrollbar-thumb").boundingBox();
  await page.mouse.move(modalThumb.x + 3, modalThumb.y + 5); await page.mouse.down();
  await page.mouse.move(modalThumb.x + 3, modalThumb.y + 65, {steps: 5}); await page.mouse.up();
  assert.ok(await page.locator("#modal").evaluate(node => node.scrollTop > 0), "Overlay scrollbars must remain interactive in modal dialogs");
  await page.evaluate(() => document.querySelector("#modal").close());
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await verticalBar.evaluate(node => getComputedStyle(node).transitionDuration), "0s");
  console.log("Verified zero-gutter overlay scrollbars, animated reveal/fade, LTR/RTL thumb dragging and keyboard scrolling, nonnegative ARIA offsets, both axes, modal dialogs and reduced-motion support in Chrome.");
} finally { await browser.close(); }
