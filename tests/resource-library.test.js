import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import initSqlJs from "../vendor/sql-wasm.js";
import { openResourceLibrary } from "../src/resource-library.js";

function diskError(error) {
  if (error.code === "ENOENT") error.name = "NotFoundError";
  if (["ENOTEMPTY", "EEXIST"].includes(error.code)) error.name = "InvalidModificationError";
  return error;
}

class DiskDirectory {
  constructor(directory, faults) { this.path = directory; this.faults = faults; this.name = path.basename(directory); }
  async queryPermission() { return this.faults.permission || "granted"; }
  async getDirectoryHandle(name, { create = false } = {}) {
    const target = path.join(this.path, name);
    try {
      if (create) await fs.mkdir(target, { recursive: true });
      assert.ok((await fs.stat(target)).isDirectory());
      return new DiskDirectory(target, this.faults);
    } catch (error) { throw diskError(error); }
  }
  async getFileHandle(name, { create = false } = {}) {
    const target = path.join(this.path, name);
    try {
      if (create) { const file = await fs.open(target, "a"); await file.close(); }
      await fs.stat(target);
      return new DiskFile(target, this.faults);
    } catch (error) { throw diskError(error); }
  }
  async removeEntry(name) {
    const target = path.join(this.path, name);
    try {
      if (this.faults.failCleanup && name.startsWith("r_")) throw new Error("Injected cleanup failure");
      if ((await fs.stat(target)).isDirectory()) await fs.rmdir(target);
      else await fs.unlink(target);
    } catch (error) { throw diskError(error); }
  }
}

class DiskFile {
  constructor(file, faults) { this.path = file; this.faults = faults; }
  async getFile() {
    try {
      if (path.basename(this.path) === "catalog.sqlite") this.faults.catalogReads = (this.faults.catalogReads || 0) + 1;
      return new File([await fs.readFile(this.path)], path.basename(this.path));
    }
    catch (error) { throw diskError(error); }
  }
  async createWritable() {
    const temporary = `${this.path}.tmp`;
    return {
      write: async data => {
        if (this.faults.failResourceWrite && path.basename(this.path).startsWith("r_")) throw new Error("Injected resource write failure");
        const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
        await fs.writeFile(temporary, bytes);
      },
      close: async () => {
        if (this.faults.failCatalogClose && path.basename(this.path) === "catalog.sqlite") throw new Error("Injected catalog close failure");
        await fs.rename(temporary, this.path);
      },
      abort: async () => { await fs.rm(temporary, { force: true }); }
    };
  }
}

test("disk resource library: attachments, queries, moves, failures, concurrency and retained orphans", async t => {
  const base = path.resolve(`.test-resources-${crypto.randomUUID()}`);
  await fs.mkdir(base);
  const SQL = await initSqlJs({ wasmBinary: await fs.readFile(new URL("../vendor/sql-wasm.wasm", import.meta.url)) });
  const originals = { initSqlJs: globalThis.initSqlJs, localStorage: globalThis.localStorage, chrome: globalThis.chrome };
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  let queue = Promise.resolve();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name, callback) => {
    const task = queue.then(callback); queue = task.catch(() => {}); return task;
  } } });
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.initSqlJs = () => Promise.resolve(SQL);
  const bookmark = { id: "b1", parentId: "nested", title: "Источник", url: "https://example.com/" };
  const nested = { id: "nested", parentId: "work", title: "Вложенная", children: [bookmark] };
  const work = { id: "work", parentId: "0", title: "Работа", children: [nested] };
  const other = { id: "other", parentId: "0", title: "Другое", children: [] };
  const tree = { id: "0", title: "", children: [work, other] };
  globalThis.chrome = { bookmarks: { getTree: async () => [tree] } };
  const faults = {};
  const directory = new DiskDirectory(base, faults);
  const catalogRows = async sql => {
    const database = new SQL.Database(await fs.readFile(path.join(base, "catalog.sqlite")));
    try {
      const result = database.exec(sql)[0];
      return result ? result.values.map(values => Object.fromEntries(result.columns.map((key, index) => [key, values[index]]))) : [];
    } finally { database.close(); }
  };
  try {
    await t.test("detects an old installed CSP with an actionable extension reload message", async () => {
      chrome.runtime = { getManifest: () => ({ content_security_policy: { extension_pages: "script-src 'self'" } }) };
      try { await assert.rejects(openResourceLibrary(directory), /chrome:\/\/extensions/); }
      finally { delete chrome.runtime; }
    });
    await t.test("reports CSP compilation errors and retries initialization on the next attempt", async () => {
      globalThis.initSqlJs = () => Promise.reject(new WebAssembly.CompileError("WebAssembly module violates Content Security policy"));
      await assert.rejects(openResourceLibrary(directory), /Обновить/);
      globalThis.initSqlJs = () => Promise.resolve(SQL);
    });
    const library = await openResourceLibrary(directory);
    await t.test("interrupted first catalog creation can be retried without discarding existing resources", async () => {
      const initial = path.join(base, "initial");
      await fs.mkdir(initial);
      const initialFaults = { failCatalogClose: true };
      const initialLibrary = await openResourceLibrary(new DiskDirectory(initial, initialFaults));
      await assert.rejects(initialLibrary.sync(), /Injected/);
      initialFaults.failCatalogClose = false;
      await initialLibrary.sync();
      assert.ok((await fs.stat(path.join(initial, "catalog.sqlite"))).size > 0);
      await fs.writeFile(path.join(initial, "catalog.sqlite"), "");
      await assert.rejects(initialLibrary.sync(), /Каталог.*пуст/);
      await fs.unlink(path.join(initial, "catalog.sqlite"));
      await assert.rejects(initialLibrary.sync(), /Каталог отсутствует/);
    });
    await t.test("mirrors empty folders and imports duplicate filenames as separate resources", async () => {
      await library.sync();
      const folders = await catalogRows("SELECT * FROM nodes WHERE kind='folder' AND parent_id IS NOT NULL");
      assert.equal(folders.length, 3);
      assert.equal((await fs.readdir(path.join(base, "tree"))).length, 2);
      await library.attach("b1", [new File(["first content"], "same.png", { type: "image/png" }), new File(["video content"], "same.png", { type: "video/mp4" })]);
      const resources = (await library.getBookmark("b1")).resources;
      assert.equal(resources.length, 2);
      assert.equal(new Set(resources.map(resource => resource.id)).size, 2);
      assert.deepEqual(await Promise.all(resources.map(async resource => (await library.getFile(resource.id)).text())), ["first content", "video content"]);
    });
    await t.test("upgrades version 1 catalogs without changing resources and persists replaceable video previews", async () => {
      const old = new SQL.Database(await fs.readFile(path.join(base, "catalog.sqlite")));
      try {
        old.run("DROP TABLE resource_previews; DROP TABLE resource_timelapses; PRAGMA user_version=1");
        await fs.writeFile(path.join(base, "catalog.sqlite"), old.export());
      } finally { old.close(); }
      await library.sync();
      assert.equal((await catalogRows("PRAGMA user_version"))[0].user_version, 4);
      const resources = await library.listResources();
      const video = resources.find(resource => resource.mediaType === "video/mp4");
      const image = resources.find(resource => resource.mediaType === "image/png");
      assert.equal(await library.getPreview(video.id), null);
      const jpeg = new Blob([new Uint8Array([255, 216, 255, 1])], { type: "image/jpeg" });
      await library.setPreview(video.id, jpeg);
      await library.setPreview(video.id, new Blob([new Uint8Array([255, 216, 255, 9])], { type: "image/jpeg" }), false);
      const reopened = await openResourceLibrary(directory);
      assert.deepEqual(new Uint8Array(await (await reopened.getPreview(video.id)).arrayBuffer()), new Uint8Array(await jpeg.arrayBuffer()));
      await assert.rejects(library.setPreview(image.id, jpeg), /только для видео/);
      await assert.rejects(library.setPreview(video.id, new Blob(["invalid"], { type: "image/jpeg" })), /JPEG/);
      const replacement = new Blob([new Uint8Array([255, 216, 255, 2])], { type: "image/jpeg" });
      faults.failCatalogClose = true;
      try { await assert.rejects(library.setPreview(video.id, replacement), /Injected/); }
      finally { faults.failCatalogClose = false; }
      assert.deepEqual(new Uint8Array(await (await library.getPreview(video.id)).arrayBuffer()), new Uint8Array(await jpeg.arrayBuffer()));
      await library.setPreview(video.id, replacement);
      assert.equal((await catalogRows("SELECT * FROM resource_previews")).length, 1);
      assert.equal(await (await library.getFile(video.id)).text(), "video content");
      assert.equal((await library.listResources()).length, 2);
      const version2 = new SQL.Database(await fs.readFile(path.join(base, "catalog.sqlite")));
      try {
        version2.run("DROP TABLE resource_timelapses; PRAGMA user_version=2");
        await fs.writeFile(path.join(base, "catalog.sqlite"), version2.export());
      } finally { version2.close(); }
      await library.sync();
      assert.equal((await catalogRows("PRAGMA user_version"))[0].user_version, 4);
      assert.deepEqual(new Uint8Array(await (await library.getPreview(video.id)).arrayBuffer()), new Uint8Array(await replacement.arrayBuffer()));
    });
    await t.test("cached preview requests share one catalog read and do not synchronize bookmarks", async () => {
      const video = (await library.listResources()).find(resource => resource.mediaType === "video/mp4");
      const readsBefore = faults.catalogReads;
      const getTree = chrome.bookmarks.getTree;
      chrome.bookmarks.getTree = async () => { throw new Error("Preview reads must not synchronize bookmarks"); };
      try {
        const images = await Promise.all([library.getPreview(video.id), library.getThumbnail(video.id), library.getPreview(video.id)]);
        assert.ok(images.every(image => image instanceof Blob && image.size > 0));
        assert.equal(faults.catalogReads - readsBefore, 1);
      } finally { chrome.bookmarks.getTree = getTree; }
    });
    await t.test("collections persist memberships without duplicating files and intersect resource queries", async () => {
      const resources = await library.listResources();
      const first = await library.createCollection("  Избранное  ");
      const second = await library.createCollection("Прочитать");
      assert.equal(first.name, "Избранное");
      await library.addToCollection(first.id, [resources[0].id]);
      await library.addToCollection(first.id, [resources[0].id]);
      await library.addToCollection(first.id, [resources[1].id]);
      await library.addToCollection(second.id, [resources[1].id]);
      const reopened = await openResourceLibrary(directory);
      assert.equal((await reopened.listCollections()).find(item => item.id === first.id).count, 2);
      assert.equal((await reopened.listCollections()).find(item => item.id === second.id).count, 1);
      assert.equal((await reopened.listResources({ collectionId: first.id, folderId: "work" })).length, 2);
      assert.equal((await reopened.listResources({ collectionId: first.id, folderId: "other" })).length, 0);
      assert.deepEqual((await reopened.listResources({ collectionId: second.id })).map(item => item.id), [resources[1].id]);
      assert.equal((await reopened.listResources()).length, resources.length);
      await assert.rejects(library.createCollection("Избранное"), /уже существует/);
      await assert.rejects(library.createCollection(" "), /название/);
      await assert.rejects(library.createCollection("x".repeat(101)), /название/);
      await assert.rejects(library.addToCollection("missing", [resources[0].id]), /Подборка не найдена/);
      await assert.rejects(library.addToCollection(first.id, ["missing"]), /Ресурс не найден/);
      await library.renameCollection(first.id, " Новое название ");
      assert.equal((await reopened.listCollections()).find(item => item.id === first.id).name, "Новое название");
      await assert.rejects(library.renameCollection(first.id, "Прочитать"), /уже существует/);
      await assert.rejects(library.renameCollection(first.id, " "), /название/);
      await assert.rejects(library.renameCollection("missing", "Название"), /не найдена/);
      const before = await Promise.all(resources.map(async resource => (await library.getFile(resource.id)).text()));
      await library.removeFromCollection(first.id, [resources[1].id]);
      await library.removeFromCollection(first.id, [resources[1].id]);
      assert.equal((await library.listResources({ collectionId: first.id })).length, 1);
      assert.equal((await library.listResources({ collectionId: second.id })).length, 1);
      faults.failCatalogClose = true;
      try { await assert.rejects(library.deleteCollection(first.id), /Injected/); }
      finally { faults.failCatalogClose = false; }
      assert.equal((await library.listResources({ collectionId: first.id })).length, 1);
      await library.deleteCollection(first.id);
      assert.equal((await reopened.listCollections()).some(item => item.id === first.id), false);
      assert.equal((await library.listResources({ collectionId: second.id })).length, 1);
      assert.deepEqual(await Promise.all(resources.map(async resource => (await library.getFile(resource.id)).text())), before);
      await assert.rejects(library.deleteCollection("missing"), /не найдена/);
      await assert.rejects(library.removeFromCollection("missing", [resources[0].id]), /не найдена/);
    });
    await t.test("batch membership changes validate every resource before saving and preserve all original files", async () => {
      const resources = await library.listResources();
      const ids = resources.map(resource => resource.id);
      const collection = await library.createCollection("Массовые операции");
      await assert.rejects(library.addToCollection(collection.id, [ids[0], "missing"]), /Ресурс не найден/);
      assert.equal((await library.listResources({ collectionId: collection.id })).length, 0);
      await assert.rejects(library.addToCollection(collection.id, []), /Выберите/);
      await assert.rejects(library.addToCollection(collection.id, [null]), /Выберите/);
      await library.addToCollection(collection.id, [...ids, ids[0]]);
      assert.equal((await library.listResources({ collectionId: collection.id })).length, ids.length);
      faults.failCatalogClose = true;
      try { await assert.rejects(library.removeFromCollection(collection.id, ids), /Injected/); }
      finally { faults.failCatalogClose = false; }
      assert.equal((await library.listResources({ collectionId: collection.id })).length, ids.length);
      await library.removeFromCollection(collection.id, ids);
      assert.equal((await library.listResources({ collectionId: collection.id })).length, 0);
      assert.equal((await library.listResources()).length, ids.length);
      for (const id of ids) assert.ok((await library.getFile(id)).size > 0);
    });
    await t.test("tag/folder/all queries intersect, including nested folder descendants", async () => {
      await library.setTags("b1", [" Работа ", "РАБОТА", "читать", ""]);
      assert.deepEqual((await library.getBookmark("b1")).tags, ["работа", "читать"]);
      assert.equal((await library.listResources()).length, 2);
      assert.equal((await library.listResources({ folderId: "work", tag: "РАБОТА" })).length, 2);
      assert.deepEqual((await library.listResources())[0].tags, ["работа", "читать"]);
      assert.equal((await library.listResources({ folderId: "other" })).length, 0);
      assert.equal((await library.listResources({ tag: "missing" })).length, 0);
      await assert.rejects(library.setTags("b1", [5]), /тегов/);
    });
    await t.test("moving an empty folder removes its old empty technical directory", async () => {
      const empty = { id: "empty", parentId: "work", title: "Пустая", children: [] };
      work.children.push(empty);
      await library.sync();
      const savedNodes = await catalogRows("SELECT * FROM nodes");
      const savedWork = savedNodes.find(node => node.chrome_id === "work");
      const savedEmpty = savedNodes.find(node => node.chrome_id === "empty");
      const oldPath = path.join(base, "tree", `f_${savedWork.id}`, `f_${savedEmpty.id}`);
      assert.ok((await fs.stat(oldPath)).isDirectory());
      work.children = work.children.filter(node => node !== empty);
      empty.parentId = "other";
      other.children.push(empty);
      await library.sync();
      await assert.rejects(fs.stat(oldPath), { code: "ENOENT" });
      other.children = other.children.filter(node => node !== empty);
      await library.sync();
    });
    await t.test("renames retain technical paths and moves relocate bytes without changing IDs or tags", async () => {
      const before = await catalogRows("SELECT id, relative_path FROM resources ORDER BY id");
      work.title = 'Переименование / CON : "';
      bookmark.title = "Переименованная закладка";
      await library.sync();
      assert.deepEqual(await catalogRows("SELECT id, relative_path FROM resources ORDER BY id"), before);
      work.children = [];
      other.children.push(nested);
      nested.parentId = "other";
      await library.sync();
      const after = await catalogRows("SELECT id, relative_path FROM resources ORDER BY id");
      assert.deepEqual(after.map(row => row.id), before.map(row => row.id));
      assert.notEqual(after[0].relative_path, before[0].relative_path);
      for (let index = 0; index < before.length; index++) {
        await assert.rejects(fs.stat(path.join(base, before[index].relative_path)), { code: "ENOENT" });
        assert.ok((await fs.stat(path.join(base, after[index].relative_path))).size > 0);
      }
      assert.equal((await library.listResources({ folderId: "other", tag: "работа" })).length, 2);
    });
    await t.test("failed import retains earlier resources and exposes pending work", async () => {
      faults.failResourceWrite = true;
      await assert.rejects(library.attach("b1", [new File(["pending bytes"], "interrupted.txt")]), /Injected/);
      faults.failResourceWrite = false;
      const metadata = await library.getBookmark("b1");
      assert.equal(metadata.resources.filter(resource => resource.status === "ready").length, 2);
      assert.equal(metadata.resources.filter(resource => resource.status === "pending").length, 1);
      assert.equal((await library.listResources()).length, 2);
    });
    await t.test("failed catalog commit preserves old tags", async () => {
      faults.failCatalogClose = true;
      await assert.rejects(library.setTags("b1", ["must not commit"]), /Injected/);
      faults.failCatalogClose = false;
      assert.deepEqual((await library.getBookmark("b1")).tags, ["работа", "читать"]);
    });
    await t.test("failed relocation preserves downloads and retries the reserved destination", async () => {
      const before = await catalogRows("SELECT * FROM resources WHERE status='ready'");
      other.children = [];
      work.children.push(nested);
      nested.parentId = "work";
      faults.failResourceWrite = true;
      const state = await library.sync();
      assert.ok(state.warnings.length > 0);
      assert.equal((await library.getFile(before[0].id)).size, before[0].size);
      await library.setTags("b1", ["работа", "читать"]);
      faults.failResourceWrite = false;
      await library.sync();
      const after = await catalogRows("SELECT * FROM resources WHERE status='ready'");
      assert.notEqual(after[0].relative_path, before[0].relative_path);
    });
    await t.test("cleanup restores a missing new destination from the retained original", async () => {
      faults.failCleanup = true;
      work.children = [];
      other.children.push(nested);
      nested.parentId = "other";
      await library.sync();
      const old = (await catalogRows("SELECT c.*, r.relative_path AS current_path FROM cleanup c JOIN resources r ON r.id=c.resource_id"))[0];
      assert.ok(old);
      await fs.unlink(path.join(base, old.current_path));
      faults.failCleanup = false;
      faults.failResourceWrite = true;
      await library.sync();
      assert.equal((await library.getFile(old.resource_id)).size, (await fs.stat(path.join(base, old.relative_path))).size);
      faults.failResourceWrite = false;
      await library.sync();
      assert.ok((await fs.stat(path.join(base, old.current_path))).size > 0);
      assert.equal((await catalogRows("SELECT * FROM cleanup")).length, 0);
    });
    await t.test("returning to an externally modified old path does not overwrite that copy", async () => {
      faults.failCleanup = true;
      other.children = [];
      work.children.push(nested);
      nested.parentId = "work";
      await library.sync();
      const old = (await catalogRows("SELECT * FROM cleanup"))[0];
      await fs.writeFile(path.join(base, old.relative_path), "manually changed copy");
      faults.failCleanup = false;
      await library.sync();
      work.children = [];
      other.children.push(nested);
      nested.parentId = "other";
      const state = await library.sync();
      assert.ok(state.warnings.some(message => message.includes("изменённая копия")));
      assert.equal(await fs.readFile(path.join(base, old.relative_path), "utf8"), "manually changed copy");
      assert.equal((await library.listResources()).length, 2);
      // Remove only the test's own conflicting copy so later cases exercise a repaired library.
      await fs.unlink(path.join(base, old.relative_path));
      await library.sync();
    });
    await t.test("a fully written pending file is recovered after metadata publication was interrupted", async () => {
      const pending = (await catalogRows("SELECT * FROM resources WHERE status='pending'"))[0];
      await fs.writeFile(path.join(base, pending.relative_path), "pending bytes");
      await library.sync();
      assert.equal((await library.getBookmark("b1")).resources.find(resource => resource.id === pending.id).status, "ready");
    });
    await t.test("concurrent instances reload catalog while holding the lock", async () => {
      const second = await openResourceLibrary(directory);
      await Promise.all([library.attach("b1", [new File(["one"], "one.txt")]), second.attach("b1", [new File(["two"], "two.txt")])]);
      assert.equal((await second.listResources()).length, 5);
    });
    await t.test("removed bookmarks retain files and metadata but leave normal resource views", async () => {
      const saved = await library.listResources();
      nested.children = [];
      await library.sync();
      assert.equal((await library.listResources()).length, 0);
      assert.equal((await library.getFile(saved[0].id)).size, saved[0].size);
      assert.equal((await catalogRows("SELECT * FROM bookmark_tags")).length, 2);
      await assert.rejects(library.attach("b1", [new File(["x"], "no.txt")]), /не существует/);
    });
    await t.test("rejects denied access and foreign profile without overwriting catalog", async () => {
      faults.permission = "denied";
      await assert.rejects(openResourceLibrary(directory), /чтение и запись/);
      faults.permission = "granted";
      const original = storage.get("resourceProfileId");
      const bytes = await fs.readFile(path.join(base, "catalog.sqlite"));
      storage.set("resourceProfileId", crypto.randomUUID());
      await assert.rejects(library.sync(), /другим профилем/);
      assert.deepEqual(await fs.readFile(path.join(base, "catalog.sqlite")), bytes);
      storage.set("resourceProfileId", original);
    });
    await t.test("unknown schema and traversal paths fail closed without touching external files", async () => {
      const original = await fs.readFile(path.join(base, "catalog.sqlite"));
      const altered = new SQL.Database(original);
      try {
        altered.run("PRAGMA user_version=99");
        await fs.writeFile(path.join(base, "catalog.sqlite"), altered.export());
        await assert.rejects(library.sync(), /Неизвестная версия/);
        altered.run("PRAGMA user_version=1");
        altered.run("UPDATE resources SET relative_path='../outside.txt' WHERE id=(SELECT id FROM resources LIMIT 1)");
        await fs.writeFile(path.join(base, "catalog.sqlite"), altered.export());
        await assert.rejects(library.sync(), /Недопустимый путь/);
      } finally {
        altered.close();
        await fs.writeFile(path.join(base, "catalog.sqlite"), original);
      }
    });
  } finally {
    if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
    else delete navigator.locks;
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
    assert.ok(base.startsWith(path.resolve(".test-resources-")));
    await fs.rm(base, { recursive: true, force: true });
  }
});
