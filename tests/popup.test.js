import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal DOM for exercising the popup's navigation and storage without Chrome.
class Element {
  children = [];
  dataset = {};
  attributes = {};
  listeners = {};
  scrollTop = 0;
  isConnected = true;
  clientWidth = 780;
  style = { setProperty: (name, value) => { this[name] = value; }, getPropertyValue: name => this[name] ?? "" };
  value = "";
  textContent = "";
  constructor(tag) { this.tagName = tag; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  getBoundingClientRect() { return { left: 0, right: 240, width: 240 }; }
  setPointerCapture(id) { this.pointerId = id; }
  hasPointerCapture(id) { return this.pointerId === id; }
  releasePointerCapture() { this.pointerId = undefined; this.listeners.lostpointercapture(); }
  focus() {}
  get childElementCount() { return this.children.length; }
  querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]).filter(child => child.dataset.id); }
}

test("popup restores navigation, expanded folders, both scroll positions and search, with safe fallbacks", async () => {
  const previous = { document: globalThis.document, chrome: globalThis.chrome, localStorage: globalThis.localStorage, window: globalThis.window };
  globalThis.window = { addEventListener() {} };
  const root = { id: "0", title: "", children: [{ id: "1", parentId: "0", title: "Работа", children: [
    { id: "2", parentId: "1", title: "Вложенная", children: [] },
    { id: "3", parentId: "1", title: "Файл", url: "file:///C:/notes.txt" }
  ] }] };
  const storage = new Map();
  const event = { addListener() {} };
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.chrome = { bookmarks: { getTree: async () => [root], onCreated: event, onRemoved: event, onChanged: event, onMoved: event, onChildrenReordered: event, onImportEnded: event } };
  let run = 0;
  async function open() {
    const elements = new Map();
    globalThis.document = {
      body: Object.assign(new Element("body"), { classList: { add() {}, remove() {}, toggle() {} } }),
      createElement: tag => new Element(tag),
      querySelector: selector => {
        if (!elements.has(selector)) elements.set(selector, new Element("div"));
        return elements.get(selector);
      }
    };
    await import(`../src/popup.js?test=${run++}`);
    await new Promise(resolve => setImmediate(resolve));
    return elements;
  }
  try {
    let ui = await open();
    assert.equal(ui.get("#items").attributes["aria-label"], "Все папки");
    assert.equal(ui.get("#bookmarks-mode").textContent, "Закладки (0)");
    const resizer = ui.get("#sidebar-resizer");
    resizer.listeners.pointerdown({ button: 0, clientX: 243, pointerId: 1, preventDefault() {} });
    resizer.listeners.pointermove({ clientX: 363, pointerId: 1 });
    resizer.listeners.pointerup({ pointerId: 1 });
    assert.equal(JSON.parse(storage.get("viewState")).sidebarWidth, 360);
    ui.get("#items").children[0].children[0].listeners.click();
    assert.equal(JSON.parse(storage.get("viewState")).selectedId, "1");
    ui.get("#items").children[0].children[0].listeners.click();
    assert.equal(JSON.parse(storage.get("viewState")).selectedId, "2");

    ui = await open();
    assert.equal(document.body["--sidebar-width"], "360px");
    ui.get("#sidebar-resizer").listeners.keydown({ key: "End", preventDefault() {} });
    assert.equal(JSON.parse(storage.get("viewState")).sidebarWidth, 534);
    ui.get("#sidebar-resizer").listeners.keydown({ key: "Home", preventDefault() {} });
    assert.equal(JSON.parse(storage.get("viewState")).sidebarWidth, 160);
    assert.equal(ui.get("#items").attributes["aria-label"], "Вложенная");
    assert.equal(ui.get("#folders").children[0].open, true);
    assert.equal(ui.get("#folders").children[0].children[1].children[0].open, true);
    assert.equal(ui.get("#folders").querySelectorAll().find(button => button.dataset.id === "2").attributes["aria-current"], "page");

    // A deliberately collapsed ancestor must stay collapsed after reopening.
    const workFolder = ui.get("#folders").children[0].children[1].children[0];
    workFolder.children[0].children[0].listeners.click({ preventDefault() {} });
    ui.get("#search").value = "Файл";
    ui.get("#search").listeners.input();
    ui.get("aside").scrollTop = 140;
    ui.get("aside").listeners.scroll();
    ui.get("main").scrollTop = 260;
    ui.get("main").listeners.scroll();
    ui = await open();
    assert.equal(ui.get("#folders").children[0].children[1].children[0].open, false);
    assert.equal(ui.get("aside").scrollTop, 140);
    assert.equal(ui.get("main").scrollTop, 260);
    assert.equal(ui.get("#search").value, "Файл");
    assert.equal(ui.get("#items").attributes["aria-label"], "Результаты поиска");
    assert.equal(ui.get("#bookmarks-mode").textContent, "Закладки (1)");

    // Breadcrumbs and sidebar selections use the same persistent navigation.
    ui.get("#breadcrumbs").children[2].listeners.click();
    assert.equal(JSON.parse(storage.get("viewState")).selectedId, "1");
    ui.get("#folders").querySelectorAll().find(button => button.dataset.id === "0").listeners.click();
    assert.equal(JSON.parse(storage.get("viewState")).selectedId, "0");

    for (const invalidId of ["deleted-folder", "3"]) {
      storage.set("viewState", JSON.stringify({ selectedId: invalidId }));
      ui = await open();
      assert.equal(ui.get("#items").attributes["aria-label"], "Все папки");
      assert.equal(JSON.parse(storage.get("viewState")).selectedId, "0");
    }

    storage.delete("viewState");
    storage.set("lastFolderId", "2");
    ui = await open();
    assert.equal(ui.get("#items").attributes["aria-label"], "Вложенная");
    assert.equal(ui.get("#folders").children[0].open, true);

    storage.set("viewState", "invalid json");
    const warn = console.warn;
    console.warn = () => {};
    try {
      ui = await open();
      assert.equal(ui.get("#items").attributes["aria-label"], "Все папки");
    } finally { console.warn = warn; }

    await ui.get("#resources-mode").listeners.click();
    assert.equal(JSON.parse(storage.get("viewState")).mode, "resources");
    assert.equal(ui.get("#resources-mode").attributes["aria-pressed"], "true");
    ui.get("#resource-scope").listeners.change({ target: { value: "folder" } });
    ui.get("#resource-tag-filter").listeners.change({ target: { value: "работа" } });
    assert.equal(JSON.parse(storage.get("viewState")).resourceScope, "folder");
    assert.equal(JSON.parse(storage.get("viewState")).resourceTag, "работа");
    ui = await open();
    assert.equal(ui.get("#resources-mode").attributes["aria-pressed"], "true");
    await ui.get("#bookmarks-mode").listeners.click();
    assert.equal(ui.get("#items").attributes["aria-label"], "Все папки");
    assert.equal(JSON.parse(storage.get("viewState")).mode, "bookmarks");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});
