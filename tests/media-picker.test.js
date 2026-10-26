import { test } from "node:test";
import assert from "node:assert/strict";
import { registerMediaPicker, startMediaPicker } from "../src/media-picker.js";

test("media picker handles a tab closed before the request or during frame injection", async () => {
  const previous = globalThis.chrome;
  const warn = console.warn;
  const warnings = [];
  let listener;
  let rejectInjection;
  let writes = 0;
  console.warn = (...args) => warnings.push(args);
  globalThis.chrome = {
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`,
      onMessage: { addListener: callback => { listener = callback; } } },
    tabs: { get: async () => { throw new Error("No tab with id: 7."); }, onRemoved: { addListener() {} } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url: "https://fixture.test/" }] },
    scripting: { executeScript: () => new Promise((_resolve, reject) => { rejectInjection = reject; }) },
    storage: { local: { set: async () => { writes++; } } }
  };
  try {
    registerMediaPicker();
    const response = await new Promise(resolve => {
      assert.equal(listener({ type: "start-media-picker", tabId: 7 },
        { id: "fixture", url: chrome.runtime.getURL("tab.html") }, resolve), true);
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /No tab/);

    await startMediaPicker({ id: 7, url: "https://fixture.test/" });
    rejectInjection(new Error("No tab with id: 7."));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings.length, 1, "Detached injection errors must reach the picker error handler");
    assert.match(warnings[0][1].message, /No tab/);
    assert.equal(writes, 0, "A closed tab must not save a stale selection");
  } finally {
    console.warn = warn;
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
