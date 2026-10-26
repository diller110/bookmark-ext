import { test } from "node:test";
import assert from "node:assert/strict";

test("toolbar follows tab URLs, duplicate bookmarks, resource counts, events and stale requests", async () => {
  const original = { chrome: globalThis.chrome, OffscreenCanvas: globalThis.OffscreenCanvas };
  const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); } });
  const icons = new Map();
  const titles = new Map();
  const tabs = new Map([[1, { id: 1, url: "https://example.com/" }], [2, { id: 2, url: "https://other.test/" }]]);
  let bookmarks = [{ id: "a", url: "https://example.com/" }, { id: "b", url: "https://example.com/" }];
  let counts = { a: 2, b: 3 };
  let queryTabs = [];
  globalThis.OffscreenCanvas = class {
    getContext() {
      const ctx = { text: "", stops: [], scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {},
        createLinearGradient: () => ({ addColorStop: (_at, color) => ctx.stops.push(color) }),
        measureText: () => ({ actualBoundingBoxLeft: 5, actualBoundingBoxRight: 5, actualBoundingBoxAscent: 13, actualBoundingBoxDescent: 0 }),
        fillText: text => { ctx.text = text; }, getImageData: () => ({ text: ctx.text, stops: ctx.stops }) };
      return ctx;
    }
  };
  globalThis.chrome = {
    tabs: { get: async id => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`); return { ...tabs.get(id) }; }, query: async () => queryTabs,
      onActivated: event(), onCreated: event(), onUpdated: event(), onRemoved: event() },
    bookmarks: { search: async () => bookmarks, onCreated: event(), onRemoved: event(), onChanged: event(), onMoved: event(), onImportEnded: event() },
    storage: { local: { get: async () => ({ resourceCounts: counts }) }, onChanged: event() },
    action: { setIcon: ({ tabId, imageData }, callback) => { icons.set(tabId, imageData); callback(); }, setTitle: async ({ tabId, title }) => titles.set(tabId, title) },
    runtime: { onInstalled: event(), onStartup: event() }
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    const { updateTab } = await import("../src/background.js");
    await updateTab(1);
    assert.equal(icons.get(1)[32].text, "5");
    assert.deepEqual(icons.get(1)[16].stops, ["#ffb74d", "#ff9800"]);
    await updateTab(2);
    assert.equal(icons.get(2)[32].text, "");
    assert.match(titles.get(2), /не в закладках/);
    counts = {};
    await updateTab(1);
    assert.equal(icons.get(1)[32].text, "0");
    counts = { a: 120, b: -1 };
    await updateTab(1);
    assert.equal(icons.get(1)[32].text, "9");
    assert.match(titles.get(1), /120$/);

    counts = { a: 7 };
    chrome.tabs.onActivated.listeners[0]({ tabId: 1 }); await flush();
    assert.equal(icons.get(1)[32].text, "7");
    counts = { a: 8 }; queryTabs = [...tabs.values()];
    chrome.storage.onChanged.listeners[0]({ resourceCounts: {} }, "local"); await flush();
    assert.equal(icons.get(1)[32].text, "8");
    bookmarks = [];
    await chrome.bookmarks.onRemoved.listeners[0]();
    assert.equal(icons.get(1)[32].text, "");
    bookmarks = [{ id: "a", url: "https://example.com/" }];
    tabs.get(1).url = "https://other.test/";
    chrome.tabs.onUpdated.listeners[0](1, { url: tabs.get(1).url }); await flush();
    assert.equal(icons.get(1)[32].text, "");

    let resolveSearch;
    chrome.bookmarks.search = () => new Promise(resolve => { resolveSearch = resolve; });
    tabs.get(1).url = "https://example.com/";
    const old = updateTab(1); await flush();
    tabs.get(1).url = "https://other.test/";
    chrome.bookmarks.search = async () => [];
    await updateTab(1);
    resolveSearch(bookmarks); await old;
    assert.equal(icons.get(1)[32].text, "");
    await assert.doesNotReject(updateTab(999));

    let lastErrorReads = 0;
    chrome.action.setIcon = (_details, callback) => {
      Object.defineProperty(chrome.runtime, "lastError", { configurable: true, get() {
        lastErrorReads++;
        return { message: "No tab with id: 1." };
      } });
      callback();
      delete chrome.runtime.lastError;
    };
    await assert.doesNotReject(updateTab(1));
    assert.equal(lastErrorReads, 1, "The callback must consume lastError when the tab closes during setIcon");
    chrome.action.setIcon = (_details, callback) => {
      chrome.runtime.lastError = { message: "Invalid image data" };
      callback();
      delete chrome.runtime.lastError;
    };
    await assert.rejects(updateTab(1), /Invalid image data/, "Unexpected icon errors must remain observable");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
