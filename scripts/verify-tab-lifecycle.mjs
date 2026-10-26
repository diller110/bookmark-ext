import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profile = await mkdtemp(join(root, ".test-incognito-tabs-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome", headless: true, locale: "ru", ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging", "--lang=ru"]
});
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: root });
  const manager = await context.newPage();
  await manager.goto("chrome://extensions/");
  await manager.evaluate(async id => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, errorCollection: true });
  }, id);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  const worker = context.serviceWorkers().find(worker => worker.url().endsWith("/src/background.js"))
    || await context.waitForEvent("serviceworker");
  const result = await worker.evaluate(async () => {
    const bounded = promise => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for icon callback")), 5000);
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    const original = chrome.action.setIcon;
    let closedDuringIcon = false;
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    chrome.action.setIcon = (details, callback) => {
      if (details.tabId !== tab.id || closedDuringIcon) return original(details, callback);
      closedDuringIcon = true;
      void chrome.tabs.remove(tab.id).then(() => original(details, () => { callback(); finish(); }));
    };
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await bounded(completed);
    } finally { chrome.action.setIcon = original; }
    for (let i = 0; i < 10; i++) {
      const closing = await chrome.tabs.create({ url: "about:blank", active: false });
      await chrome.tabs.remove(closing.id);
    }
    const live = await chrome.tabs.create({ url: "about:blank", active: false });
    const updated = new Promise(resolve => {
      chrome.action.setIcon = (details, callback) => original(details, () => {
        callback();
        if (details.tabId === live.id) resolve();
      });
    });
    try {
      await chrome.tabs.update(live.id, { active: true });
      await bounded(updated);
    } finally { chrome.action.setIcon = original; }
    const title = await chrome.action.getTitle({ tabId: live.id });
    const closed = await chrome.tabs.create({ url: "about:blank", active: false });
    await chrome.tabs.remove(closed.id);
    const operations = {
      get: () => chrome.tabs.get(closed.id),
      title: () => chrome.action.setTitle({ tabId: closed.id, title: "Closed tab" }),
      frames: () => chrome.webNavigation.getAllFrames({ tabId: closed.id }),
      script: () => chrome.scripting.executeScript({ target: { tabId: closed.id }, func: () => null })
    };
    const outcomes = {};
    for (const [name, operation] of Object.entries(operations)) {
      try { await operation(); outcomes[name] = "resolved"; }
      catch (error) { outcomes[name] = error.message; }
    }
    return { title, closedDuringIcon, outcomes, closedTabId: closed.id };
  });
  assert.match(result.title, /Полка закладок/);
  assert.equal(result.closedDuringIcon, true, "Must exercise closing a tab during setIcon");
  assert.match(result.outcomes.get, /No tab/);
  assert.match(result.outcomes.title, /No tab/);
  assert.match(result.outcomes.script, /No tab/);
  console.log("Closed-tab API checks passed.");
  await worker.evaluate(() => {
    const original = chrome.storage.local.get;
    let resume;
    const gate = new Promise(resolve => { resume = resolve; });
    globalThis.lifecycleResume = resume;
    globalThis.lifecycleWaiting = false;
    chrome.storage.local.get = async key => {
      if (key === "downloadQueue") {
        chrome.storage.local.get = original;
        globalThis.lifecycleWaiting = true;
        await gate;
      }
      return original(key);
    };
  });
  const windowId = await worker.evaluate(async () => (await chrome.windows.create({ url: chrome.runtime.getURL("tab.html"), type: "popup" })).id);
  let popup;
  for (let i = 0; i < 100 && !popup; i++) {
    popup = context.pages().find(page => page.url() === `chrome-extension://${id}/tab.html`);
    if (!popup) await delay(20);
  }
  assert.ok(popup, "Chrome must open the extension popup window");
  await popup.waitForFunction(() => Boolean(document.querySelector("#download-status")), undefined, { polling: 50 });
  assert.equal(await worker.evaluate(async () => {
    for (let i = 0; i < 100 && !globalThis.lifecycleWaiting; i++) await new Promise(resolve => setTimeout(resolve, 20));
    return globalThis.lifecycleWaiting;
  }), true, "Popup must have a pending background request before it closes");
  await worker.evaluate(async windowId => {
    await chrome.windows.remove(windowId);
    globalThis.lifecycleResume();
    delete globalThis.lifecycleResume;
  }, windowId);
  const queue = await page.evaluate(() => chrome.runtime.sendMessage({ target: "download-background", type: "status" }));
  assert.equal(queue.ok, true, "Background must finish replying after the requesting window closes");
  console.log("Closed-window background reply passed.");
  const rejected = await page.evaluate(tabId => chrome.runtime.sendMessage({ target: "download-background", type: "start", payload: {
    tabId, url: "https://fixture.test/article", title: "Closed media tab",
    candidate: { frameId: 0, frameUrl: "https://fixture.test/article", origin: "https://fixture.test", kind: "video", url: "https://fixture.test/video.mp4" }
  } }), result.closedTabId);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /No tab/, "Download handler must turn a closed source tab into a normal error response");
  await manager.bringToFront();
  await manager.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const errors = await manager.evaluate(async id => {
    const info = await chrome.developerPrivate.getExtensionInfo(id);
    return info.runtimeErrors.map(error => error.message);
  }, id);
  assert.deepEqual(errors, [], "Chrome must record no unchecked runtime errors after closing tabs");
  console.log("Tab lifecycle passed: icon updates, APIs on closed tabs, 10 rapid tab closures and popup window closed during a background reply; no Chrome runtime errors.");
} finally {
  await context.close();
  assert.equal(dirname(resolve(profile)), root);
  assert.ok(basename(profile).startsWith(".test-incognito-tabs-"));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
