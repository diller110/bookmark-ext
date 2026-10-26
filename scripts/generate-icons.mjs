import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const source = await readFile(new URL("../src/toolbar-icon.js", import.meta.url), "utf8");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async source => {
    const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const { toolbarIcon } = await import(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    const encode = async canvas => [...new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer())];
    const icons = [];
    for (const size of [16, 32, 48, 128]) {
      const canvas = new OffscreenCanvas(size, size);
      canvas.getContext("2d").putImageData(toolbarIcon(false, 0, size), 0, 0);
      icons.push({ size, bytes: await encode(canvas) });
    }
    const nine = toolbarIcon(true, 9, 32), capped = toolbarIcon(true, 120, 32);
    const pixel = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
    const strip = new OffscreenCanvas(480, 180), ctx = strip.getContext("2d");
    ctx.fillStyle = "#202124"; ctx.fillRect(0, 0, 480, 180);
    for (const [row, size] of [16, 32, 48].entries()) {
      for (const [column, count] of [null, 0, 4, 9, 120].entries()) {
        const icon = new OffscreenCanvas(size, size);
        icon.getContext("2d").putImageData(toolbarIcon(count !== null, count, size), 0, 0);
        ctx.drawImage(icon, column * 96 + (96 - size) / 2, row * 60 + (60 - size) / 2);
      }
    }
    return { icons, capped: nine.data.every((value, index) => value === capped.data[index]), outside: pixel(nine, 2, 16), outline: pixel(nine, 5, 14), preview: await encode(strip) };
  }, source);
  assert.equal(result.capped, true, "Counts above nine must render as nine");
  assert.equal(result.outside[3], 0, "The old square perimeter must remain transparent");
  assert.ok(result.outline[0] > result.outline[1] && result.outline[1] > result.outline[2] && result.outline[3] > 0, "The bookmark outline must be orange");
  for (const { size, bytes } of result.icons) await writeFile(new URL(`../icons/bookmark-${size}.png`, import.meta.url), Buffer.from(bytes));
  if (process.env.TOOLBAR_SCREENSHOT) await writeFile(process.env.TOOLBAR_SCREENSHOT, Buffer.from(result.preview));
  console.log("Generated bookmark icons at 16, 32, 48 and 128px; verified orange bookmark outline, transparent square perimeter and single-digit count cap.");
} finally { await browser.close(); }
