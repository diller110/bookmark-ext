// Real manager, offscreen runner, storage/SQLite and workers; only Chrome's extension transport is simulated.
export async function downloadHarness(context, page, initialize, manifest) {
  let background;
  let offscreen;
  let opening;
  const pages = new Set();
  const origin = "http://localhost:8123/";
  const id = "bookmark-test-extension";
  const getURL = path => new URL(path, origin).href;
  const errors = [];
  async function dispatch(target, message, sender) {
    return target.evaluate(({ message, sender }) => new Promise(resolve => {
      for (const listener of window.__runtimeListeners) {
        let sent = false;
        const result = listener(message, sender, response => { sent = true; resolve(response); });
        if (sent || result === true) return;
      }
      resolve(undefined);
    }), { message, sender });
  }
  async function attach(target, role) {
    pages.add(target);
    target.on("pageerror", error => errors.push(`${role}: ${error.message}`));
    await target.exposeBinding("downloadRuntime", async (_binding, message) => {
      const destination = message.target === "download-offscreen" ? offscreen : background;
      if (!destination || destination.isClosed()) throw new Error("No receiving context");
      return dispatch(destination, message, { id, url: role === "background" ? getURL("src/background.js") : role === "offscreen" ? getURL("download-offscreen.html") : target.url() });
    });
    await target.exposeBinding("downloadContexts", () => offscreen && !offscreen.isClosed() ? [{ documentUrl: getURL("download-offscreen.html") }] : []);
    await target.exposeBinding("downloadCreate", async () => {
      if (offscreen && !offscreen.isClosed()) throw new Error("Only one offscreen document is allowed");
      opening ||= (async () => {
        offscreen = await context.newPage();
        await attach(offscreen, "offscreen");
        await offscreen.goto(getURL("download-offscreen.html"));
        await offscreen.waitForFunction(() => window.__runtimeListeners.length > 0);
      })().finally(() => { opening = undefined; });
      await opening;
    });
    await target.exposeBinding("downloadClose", async () => {
      const closing = offscreen; offscreen = undefined;
      if (closing && !closing.isClosed()) { pages.delete(closing); await closing.close(); }
    });
    await target.exposeBinding("downloadChanged", async (_binding, changes) => {
      await Promise.all([...pages].filter(entry => !entry.isClosed()).map(entry => entry.evaluate(changes => {
        for (const listener of window.__storageListeners || []) listener(changes, "local");
      }, changes).catch(() => {})));
    });
    const patch = ({ role, manifest, id, origin }) => {
      const event = () => ({ addListener() {} });
      if (role === "offscreen") window.chrome = {};
      const runtime = window.chrome.runtime ||= {};
      runtime.id = id; runtime.getManifest = () => manifest; runtime.getURL = path => new URL(path, origin).href;
      window.__runtimeListeners = [];
      runtime.onMessage = { addListener: listener => window.__runtimeListeners.push(listener) };
      runtime.sendMessage = message => window.downloadRuntime(message);
      runtime.getContexts = () => window.downloadContexts();
      runtime.onStartup ||= event(); runtime.onInstalled ||= event();
      window.__storageListeners = [];
      if (role !== "offscreen") {
        const storage = window.chrome.storage ||= {};
        storage.onChanged = { addListener: listener => window.__storageListeners.push(listener) };
        storage.local = {
          get: async key => ({ [key]: JSON.parse(localStorage.getItem(`harness-${key}`) || "null") }),
          set: async values => {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              const oldValue = JSON.parse(localStorage.getItem(`harness-${key}`) || "null");
              localStorage.setItem(`harness-${key}`, JSON.stringify(value));
              if (JSON.stringify(oldValue) !== JSON.stringify(value)) changes[key] = { oldValue, newValue: value };
            }
            if (Object.keys(changes).length) await window.downloadChanged(changes);
          }
        };
        window.chrome.offscreen = { createDocument: () => window.downloadCreate(), closeDocument: () => window.downloadClose() };
        window.chrome.action ||= { setIcon: async () => {}, setTitle: async () => {} };
        for (const name of ["onActivated", "onCreated", "onUpdated", "onRemoved"]) window.chrome.tabs[name] ||= event();
        for (const name of ["onCreated", "onRemoved", "onChanged", "onMoved", "onImportEnded"]) window.chrome.bookmarks[name] ||= event();
      }
      FileSystemHandle.prototype.queryPermission = async () => localStorage.getItem("testDirectoryPermission") || "granted";
    };
    await target.addInitScript({ content: `${role === "offscreen" ? "" : `(${initialize.toString()})(${JSON.stringify({ manifest })});`}(${patch.toString()})(${JSON.stringify({ role, manifest, id, origin })});` });
  }
  await attach(page, "popup");
  background = await context.newPage();
  await attach(background, "background");
  await background.goto(getURL("fixture.html"));
  await background.evaluate(() => import("./src/background.js"));
  return {
    errors,
    background,
    worker: () => offscreen,
    async reopen() {
      const popup = await context.newPage();
      await attach(popup, "popup");
      await popup.goto(getURL("tab.html"));
      return popup;
    },
    async crashWorker() { if (offscreen && !offscreen.isClosed()) await offscreen.close(); offscreen = undefined; }
  };
}
