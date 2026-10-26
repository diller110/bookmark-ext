import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { collectPageMedia } from "../src/page-media.js";
import { startMediaPicker, pickedMediaKey } from "../src/media-picker.js";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.route("https://fixture.test/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <style>body{margin:0}video{display:block}#large{width:600px;height:300px}#small{width:100px;height:50px}#photo{width:250px;height:150px}#background{width:200px;height:80px;background-image:url("https://fixture.test/background.png")}</style>
    <video id="small" src="https://fixture.test/small.mp4" poster="data:image/png;base64,AA=="></video>
    <div id="player"><video id="large" src="https://fixture.test/large.mp4" poster="data:image/png;base64,AA=="></video><div id="overlay"><button id="play"><span id="play-label">Play</span></button></div></div>
    <img id="photo" src="https://fixture.test/photo.png"><div id="background"></div><a id="link" href="/elsewhere">Link</a>` }));
  await page.goto("https://fixture.test/article");
  const scan = await page.evaluate(collectPageMedia);
  assert.deepEqual(scan.map(item => item.url), ["https://fixture.test/large.mp4", "https://fixture.test/small.mp4"]);
  const values = {};
  let currentUrl = page.url();
  globalThis.chrome = {
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url: page.url() }] },
    tabs: { get: async () => ({ url: currentUrl }) },
    permissions: { contains: async () => true },
    storage: { local: { set: async value => Object.assign(values, value) } },
    scripting: { executeScript: async ({ func, args = [] }) => [{ result: await page.evaluate(`(${func.toString()})(...${JSON.stringify(args)})`) }] }
  };
  const begin = async () => {
    await startMediaPicker({ id: 7, url: page.url() });
    await page.waitForFunction(() => Boolean(globalThis.__bookmarkMediaPicker));
  };
  const waitSelected = async url => {
    const deadline = Date.now() + 5000;
    while (values[pickedMediaKey(7)]?.candidates[0]?.url !== url && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(values[pickedMediaKey(7)]?.candidates[0]?.url, url);
    await page.waitForFunction(() => !globalThis.__bookmarkMediaPicker);
  };
  await begin();
  await page.locator("#small").hover();
  await page.locator("#small").click();
  await waitSelected("https://fixture.test/small.mp4");
  await begin();
  await page.locator("#play-label").click();
  await waitSelected("https://fixture.test/large.mp4");
  assert.equal(values[pickedMediaKey(7)].candidates.length, 1);
  await begin();
  await page.locator("#overlay").click({ position: { x: 500, y: 5 } });
  await waitSelected("https://fixture.test/large.mp4");
  await begin();
  await page.locator("#photo").click();
  await waitSelected("https://fixture.test/photo.png");
  await begin();
  await page.locator("#background").click();
  await waitSelected("https://fixture.test/background.png");
  const saved = JSON.stringify(values);
  await begin();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !globalThis.__bookmarkMediaPicker);
  assert.equal(JSON.stringify(values), saved);
  await begin();
  currentUrl = "https://fixture.test/elsewhere";
  await page.locator("#small").click();
  await page.waitForFunction(() => !globalThis.__bookmarkMediaPicker);
  assert.equal(JSON.stringify(values), saved);
  currentUrl = page.url();
  await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.srcdoc = '<img id="inside" src="https://fixture.test/inside.png" style="width:100px;height:80px">';
    document.body.append(iframe);
  });
  await page.frames()[1].waitForSelector("#inside");
  chrome.webNavigation.getAllFrames = async () => [{ frameId: 0, url: page.url() }, { frameId: 1, parentFrameId: 0, url: "about:srcdoc" }];
  chrome.scripting.executeScript = async ({ func, args = [], target }) => Promise.all(target.frameIds.map(async id => ({ result: await page.frames()[id].evaluate(`(${func.toString()})(...${JSON.stringify(args)})`) })));
  await begin();
  await page.frames()[1].locator("#inside").click();
  await waitSelected("https://fixture.test/inside.png");
  assert.equal(values[pickedMediaKey(7)].candidates[0].frameId, 1);
  assert.equal(values[pickedMediaKey(7)].candidates[0].origin, "https://fixture.test");
  console.log("Verified rendered-area sorting, nearest media ancestor selection through player controls/overlays, direct video/image/CSS-background selection, persistence, Escape cleanup and stale-page rejection in Chrome.");
} finally { await browser.close(); }
