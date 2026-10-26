import { t } from "./i18n.js";
import { indexTree } from "./model.js";
import { getResourceDirectory } from "./resource-directory.js";
import { getBookmarkTree, setResourceCounts, downloadCall } from "./extension-bridge.js";
import { sharedLibrary } from "./shared-library-client.js";
import { createVideoThumbnail, createVideoTimelapse } from "./video-thumbnail.js";

const catalogName = "catalog.sqlite";
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const resourcePathPattern = new RegExp(`^tree/(?:f_${uuidPattern}/)*b_${uuidPattern}/r_${uuidPattern}(?:\\.[a-z0-9]{1,12})?$`);
const folderPathPattern = new RegExp(`^tree(?:/f_${uuidPattern})+$`);
let engine;
const thumbnailRequests = new Map();

function rows(database, sql, parameters = []) {
  const statement = database.prepare(sql);
  try {
    statement.bind(parameters);
    const result = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally { statement.free(); }
}

function checkedPath(path) {
  if (!resourcePathPattern.test(path)) throw new Error(t("Недопустимый путь ресурса в каталоге"));
  return path.split("/");
}

async function directoryAt(root, segments, create = false) {
  let directory = root;
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment, { create });
  return directory;
}

async function resourceHandle(root, path, create = false) {
  const segments = checkedPath(path);
  const name = segments.pop();
  return (await directoryAt(root, segments, create)).getFileHandle(name, { create });
}

async function writeFile(handle, data) {
  const writer = await handle.createWritable();
  try {
    await writer.write(data);
    await writer.close();
  } catch (error) {
    try { await writer.abort(); } catch { /* The stream may already be closed. */ }
    throw error;
  }
}

async function filesEqual(first, second) {
  if (first.size !== second.size) return false;
  for (let offset = 0; offset < first.size; offset += 1024 * 1024) {
    const end = offset + 1024 * 1024;
    const a = new Uint8Array(await first.slice(offset, end).arrayBuffer());
    const b = new Uint8Array(await second.slice(offset, end).arrayBuffer());
    if (!a.every((value, index) => value === b[index])) return false;
  }
  return true;
}

function folderPath(node, nodes) {
  const segments = [];
  const seen = new Set();
  while (node && node.parent_id !== null) {
    if (seen.has(node.id)) throw new Error(t("Цикл папок в каталоге"));
    seen.add(node.id);
    segments.unshift(`f_${node.id}`);
    node = nodes.get(node.parent_id);
    if (!node) throw new Error(t("Отсутствует родитель папки в каталоге"));
  }
  return ["tree", ...segments];
}

function bookmarkDirectory(bookmark, nodes) {
  const parent = nodes.get(bookmark.parent_id);
  if (!parent) throw new Error(t("Отсутствует папка закладки"));
  return [...folderPath(parent, nodes), `b_${bookmark.id}`];
}

function validateCatalog(database, profileId) {
  if (![1, 2, 3, 4].includes(rows(database, "PRAGMA user_version")[0].user_version)) throw new Error(t("Неизвестная версия каталога ресурсов"));
  if (rows(database, "PRAGMA quick_check")[0].quick_check !== "ok") throw new Error(t("Каталог ресурсов повреждён"));
  if (rows(database, "PRAGMA foreign_key_check").length) throw new Error(t("Нарушены связи в каталоге ресурсов"));
  if (rows(database, "SELECT value FROM meta WHERE key = 'profileId'")[0]?.value !== profileId) {
    throw new Error(t("Эта папка ресурсов связана с другим профилем Chrome"));
  }
  for (const node of rows(database, "SELECT * FROM nodes")) {
    if (!new RegExp(`^${uuidPattern}$`).test(node.id)) throw new Error(t("Недопустимый ID узла в каталоге"));
  }
  for (const resource of rows(database, "SELECT * FROM resources")) checkedPath(resource.relative_path);
  for (const old of rows(database, "SELECT * FROM cleanup")) checkedPath(old.relative_path);
  for (const pending of rows(database, "SELECT * FROM pending_moves")) checkedPath(pending.relative_path);
  for (const folder of rows(database, "SELECT * FROM stale_folders")) {
    if (!folderPathPattern.test(folder.relative_path)) throw new Error(t("Недопустимый путь папки в каталоге"));
  }
}

function initializeCatalog(database, profileId) {
  database.run(`
    PRAGMA user_version = 1;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, chrome_id TEXT NOT NULL UNIQUE, parent_id TEXT REFERENCES nodes(id),
      kind TEXT NOT NULL CHECK(kind IN ('folder','bookmark')), title TEXT NOT NULL, url TEXT,
      present INTEGER NOT NULL CHECK(present IN (0,1))
    );
    CREATE INDEX nodes_parent ON nodes(parent_id);
    CREATE TABLE resources (
      id TEXT PRIMARY KEY, bookmark_id TEXT NOT NULL REFERENCES nodes(id), name TEXT NOT NULL,
      media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0), created_at TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','ready'))
    );
    CREATE INDEX resources_bookmark ON resources(bookmark_id);
    CREATE TABLE bookmark_tags (
      bookmark_id TEXT NOT NULL REFERENCES nodes(id), tag TEXT NOT NULL,
      PRIMARY KEY(bookmark_id, tag)
    );
    CREATE INDEX tags_lookup ON bookmark_tags(tag, bookmark_id);
    CREATE TABLE cleanup (
      resource_id TEXT NOT NULL REFERENCES resources(id), relative_path TEXT NOT NULL,
      PRIMARY KEY(resource_id, relative_path)
    );
    CREATE TABLE pending_moves (
      resource_id TEXT NOT NULL REFERENCES resources(id), relative_path TEXT NOT NULL,
      PRIMARY KEY(resource_id, relative_path)
    );
    CREATE TABLE stale_folders (relative_path TEXT PRIMARY KEY);
  `);
  database.run("INSERT INTO meta VALUES ('profileId', ?), ('libraryId', ?)", [profileId, crypto.randomUUID()]);
}

async function loadCatalog(root, SQL, profileId) {
  let bytes;
  try { bytes = new Uint8Array(await (await (await root.getFileHandle(catalogName)).getFile()).arrayBuffer()); }
  catch (error) { if (error.name !== "NotFoundError") throw error; }
  if (!bytes?.length) {
    try {
      await root.getDirectoryHandle("tree");
      throw new Error(t("Каталог отсутствует или пуст, но папки ресурсов существуют. Восстановите каталог из резервной копии."));
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
      bytes = undefined;
    }
  }
  const database = bytes ? new SQL.Database(bytes) : new SQL.Database();
  try {
    if (bytes) validateCatalog(database, profileId);
    else initializeCatalog(database, profileId);
    database.run("PRAGMA foreign_keys = ON");
    if (rows(database, "PRAGMA user_version")[0].user_version === 1) {
      database.run(`CREATE TABLE resource_previews (
        resource_id TEXT PRIMARY KEY REFERENCES resources(id), image BLOB NOT NULL
      ); PRAGMA user_version = 2;`);
    }
    if (rows(database, "PRAGMA user_version")[0].user_version === 2) {
      database.run(`CREATE TABLE resource_timelapses (
        resource_id TEXT PRIMARY KEY REFERENCES resources(id), image BLOB NOT NULL
      ); PRAGMA user_version = 3;`);
      await saveCatalog(root, database);
    }
    if (rows(database, "PRAGMA user_version")[0].user_version === 3) {
      database.run(`CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS collection_resources (
          collection_id TEXT NOT NULL REFERENCES collections(id), resource_id TEXT NOT NULL REFERENCES resources(id),
          PRIMARY KEY(collection_id, resource_id)
        ); PRAGMA user_version = 4;`);
      await saveCatalog(root, database);
    }
    return database;
  } catch (error) { database.close(); throw error; }
}

async function saveCatalog(root, database) {
  // shortcut: export all metadata; use a worker/VFS when measured catalog latency requires it.
  await writeFile(await root.getFileHandle(catalogName, { create: true }), database.export());
  database.run("PRAGMA foreign_keys = ON");
  await publishResourceCounts(root, database);
}

async function publishResourceCounts(root, database) {
  if (!globalThis.chrome?.storage?.local && !globalThis.chrome?.runtime?.sendMessage) return;
  try {
    const selected = await getResourceDirectory();
    if (!selected || !await selected.isSameEntry(root)) return;
    const counts = rows(database, `SELECT n.chrome_id, COUNT(*) AS count FROM resources r
      JOIN nodes n ON n.id=r.bookmark_id WHERE r.status='ready' GROUP BY n.chrome_id`);
    await setResourceCounts(Object.fromEntries(counts.map(row => [row.chrome_id, row.count])));
  } catch (error) { console.warn(t("Не удалось обновить счётчик ресурсов на значке"), error); }
}

async function reconcile(root, database) {
  const warnings = [];
  const [tree] = await getBookmarkTree();
  const live = indexTree(tree);
  const existing = rows(database, "SELECT * FROM nodes");
  const previousNodes = new Map(existing.map(node => [node.id, node]));
  const byChromeId = new Map(existing.map(node => [node.chrome_id, node]));
  let changed = false;
  for (const node of live.values()) {
    const previous = byChromeId.get(node.id);
    const current = {
      id: previous?.id || crypto.randomUUID(), chrome_id: node.id,
      parent_id: node.parentId ? byChromeId.get(node.parentId)?.id : null,
      kind: node.url ? "bookmark" : "folder", title: node.title || "", url: node.url || null, present: 1
    };
    if (!previous || Object.keys(current).some(key => current[key] !== previous[key])) {
      database.run(`INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(chrome_id) DO UPDATE SET parent_id=excluded.parent_id, title=excluded.title, url=excluded.url, present=1`,
      [current.id, current.chrome_id, current.parent_id, current.kind, current.title, current.url]);
      changed = true;
    }
    byChromeId.set(node.id, current);
  }
  for (const previous of existing) {
    if (previous.present && !live.has(previous.chrome_id)) {
      database.run("UPDATE nodes SET present=0 WHERE id=?", [previous.id]);
      changed = true;
    }
  }
  for (const pending of rows(database, "SELECT * FROM resources WHERE status='pending'")) {
    try {
      const file = await (await resourceHandle(root, pending.relative_path)).getFile();
      if (file.size === pending.size) {
        database.run("UPDATE resources SET status='ready' WHERE id=?", [pending.id]);
        changed = true;
      }
    } catch (error) { if (error.name !== "NotFoundError") throw error; }
  }
  const currentNodes = new Map(rows(database, "SELECT * FROM nodes").map(node => [node.id, node]));
  for (const old of existing.filter(node => node.kind === "folder" && node.parent_id !== null)) {
    const current = currentNodes.get(old.id);
    if (current.present && folderPath(old, previousNodes).join("/") !== folderPath(current, currentNodes).join("/")) {
      database.run("INSERT OR IGNORE INTO stale_folders VALUES (?)", [folderPath(old, previousNodes).join("/")]);
      changed = true;
    }
  }
  if (changed) await saveCatalog(root, database);
  const nodes = new Map(rows(database, "SELECT * FROM nodes").map(node => [node.id, node]));
  const liveFolders = new Set([...nodes.values()].filter(node => node.present && node.kind === "folder").map(node => folderPath(node, nodes).join("/")));
  for (const resource of rows(database, "SELECT r.* FROM resources r JOIN nodes n ON n.id=r.bookmark_id WHERE r.status='ready' AND n.present=1")) {
    const target = [...bookmarkDirectory(nodes.get(resource.bookmark_id), nodes), resource.relative_path.split("/").at(-1)].join("/");
    if (target === resource.relative_path) continue;
    try {
      const sourceFile = await (await resourceHandle(root, resource.relative_path)).getFile();
      let destination;
      try { destination = await resourceHandle(root, target); }
      catch (error) { if (error.name !== "NotFoundError") throw error; }
      let matches = false;
      if (destination) {
        const existingFile = await destination.getFile();
        matches = await filesEqual(sourceFile, existingFile);
        const reserved = rows(database, "SELECT resource_id FROM pending_moves WHERE resource_id=? AND relative_path=?", [resource.id, target]).length;
        if (!matches && !(reserved && existingFile.size === 0)) throw new Error(t("В месте назначения уже есть изменённая копия; оба файла сохранены"));
      }
      if (!matches) {
        database.run("INSERT OR IGNORE INTO pending_moves VALUES (?, ?)", [resource.id, target]);
        await saveCatalog(root, database);
        destination ||= await resourceHandle(root, target, true);
        await writeFile(destination, sourceFile);
        if (!await filesEqual(sourceFile, await destination.getFile())) throw new Error(t("Не удалось проверить перенесённый ресурс"));
      }
    } catch (error) {
      warnings.push(t("Перенос «$1»: $2", [resource.name, error.message]));
      continue;
    }
    database.run("UPDATE resources SET relative_path=? WHERE id=?", [target, resource.id]);
    database.run("INSERT OR IGNORE INTO cleanup VALUES (?, ?)", [resource.id, resource.relative_path]);
    database.run("DELETE FROM pending_moves WHERE resource_id=? AND relative_path=?", [resource.id, target]);
    await saveCatalog(root, database);
  }
  let cleaned = false;
  for (const old of rows(database, "SELECT c.*, r.relative_path AS current_path FROM cleanup c JOIN resources r ON r.id=c.resource_id")) {
    if (rows(database, "SELECT id FROM resources WHERE relative_path=?", [old.relative_path]).length) {
      database.run("DELETE FROM cleanup WHERE resource_id=? AND relative_path=?", [old.resource_id, old.relative_path]);
      cleaned = true;
      continue;
    }
    const segments = checkedPath(old.relative_path);
    const name = segments.pop();
    let source;
    try { source = await resourceHandle(root, old.relative_path); }
    catch (error) {
      if (error.name === "NotFoundError") {
        database.run("DELETE FROM cleanup WHERE resource_id=? AND relative_path=?", [old.resource_id, old.relative_path]);
        cleaned = true;
      } else warnings.push(t("Чтение старой копии: $1", [error.message]));
      continue;
    }
    try {
      let current;
      try { current = await resourceHandle(root, old.current_path); }
      catch (error) {
        if (error.name !== "NotFoundError") throw error;
        database.run("INSERT OR IGNORE INTO pending_moves VALUES (?, ?)", [old.resource_id, old.current_path]);
        await saveCatalog(root, database);
        current = await resourceHandle(root, old.current_path, true);
      }
      const reserved = rows(database, "SELECT resource_id FROM pending_moves WHERE resource_id=? AND relative_path=?", [old.resource_id, old.current_path]).length;
      if (reserved && (await current.getFile()).size === 0) {
        await writeFile(current, await source.getFile());
      }
      if (!await filesEqual(await source.getFile(), await current.getFile())) continue;
      database.run("DELETE FROM pending_moves WHERE resource_id=? AND relative_path=?", [old.resource_id, old.current_path]);
      await (await directoryAt(root, segments)).removeEntry(name);
      while (segments.length > 1 && !liveFolders.has(segments.join("/"))) {
        const child = segments.pop();
        try { await (await directoryAt(root, segments)).removeEntry(child); }
        catch (error) { if (["InvalidModificationError", "NotFoundError"].includes(error.name)) break; throw error; }
      }
    } catch (error) { warnings.push(t("Очистка старой копии: $1", [error.message])); continue; }
    database.run("DELETE FROM cleanup WHERE resource_id=? AND relative_path=?", [old.resource_id, old.relative_path]);
    cleaned = true;
  }
  for (const stale of rows(database, "SELECT * FROM stale_folders ORDER BY length(relative_path) DESC")) {
    try {
      if (!liveFolders.has(stale.relative_path)) {
        const segments = stale.relative_path.split("/");
        const name = segments.pop();
        await (await directoryAt(root, segments)).removeEntry(name);
      }
    } catch (error) {
      if (error.name === "InvalidModificationError") continue;
      if (error.name !== "NotFoundError") { warnings.push(t("Удаление пустой старой папки: $1", [error.message])); continue; }
    }
    database.run("DELETE FROM stale_folders WHERE relative_path=?", [stale.relative_path]);
    cleaned = true;
  }
  if (cleaned) await saveCatalog(root, database);
  for (const folder of liveFolders) {
    try { await directoryAt(root, folder.split("/"), true); }
    catch (error) { warnings.push(t("Создание папки: $1", [error.message])); }
  }
  return warnings;
}

function currentBookmark(database, chromeId) {
  const bookmark = rows(database, "SELECT * FROM nodes WHERE chrome_id=? AND kind='bookmark' AND present=1", [chromeId])[0];
  if (!bookmark) throw new Error(t("Закладка больше не существует в Chrome"));
  return bookmark;
}

function resourceRecord(row) {
  return { id: row.id, bookmarkId: row.chrome_id, bookmarkTitle: row.title, bookmarkUrl: row.url,
    name: row.name, mediaType: row.media_type, size: row.size, createdAt: row.created_at, status: row.status };
}

function collectionName(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) throw new Error(t("Введите название подборки от 1 до 100 символов"));
  return name.trim().normalize("NFC");
}

function collectionResourceIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== "string" || !id || id.length > 100)) throw new Error(t("Выберите от 1 до 10000 ресурсов"));
  return [...new Set(ids)];
}

export async function openResourceLibrary(root) {
  if (!root) throw new Error(t("Сначала выберите папку ресурсов в настройках"));
  if (root.sharedLibraryId) return sharedLibrary(root);
  if (await root.queryPermission({ mode: "readwrite" }) !== "granted") throw new Error(t("Разрешите чтение и запись в папку ресурсов"));
  const reloadMessage = t("Chrome запрещает WebAssembly для этой версии расширения. Откройте chrome://extensions, нажмите «Обновить» на карточке «Полка закладок», затем закройте и заново откройте окно или вкладку расширения.");
  if (chrome.runtime?.getManifest && !chrome.runtime.getManifest().content_security_policy?.extension_pages?.includes("'wasm-unsafe-eval'")) {
    throw new Error(reloadMessage);
  }
  engine ||= Promise.resolve().then(() => globalThis.initSqlJs({ locateFile: () => new URL("../vendor/sql-wasm.wasm", import.meta.url).href })).catch(error => {
    engine = undefined;
    if (/content security|wasm.*eval|webassembly.*policy/i.test(error.message)) throw new Error(reloadMessage, { cause: error });
    throw error;
  });
  const SQL = await engine;
  async function operate(callback, allowStaleRead = false, synchronize = true) {
    return navigator.locks.request("bookmark-resource-library", async () => {
      let profileId = localStorage.getItem("resourceProfileId");
      if (!profileId) { profileId = crypto.randomUUID(); localStorage.setItem("resourceProfileId", profileId); }
      let database = await loadCatalog(root, SQL, profileId);
      try {
        let warnings;
        try { warnings = synchronize ? await reconcile(root, database) : []; }
        catch (error) {
          if (!allowStaleRead) throw error;
          database.close();
          database = await loadCatalog(root, SQL, profileId);
          warnings = [t("Синхронизация отложена: $1", [error.message])];
        }
        const result = await callback(database, warnings);
        if (synchronize) await publishResourceCounts(root, database);
        return result;
      } finally { database.close(); }
    });
  }
  let previewReads = [];
  function readCachedPreview(table, id) {
    return new Promise((resolve, reject) => {
      previewReads.push({ table, id, resolve, reject });
      if (previewReads.length !== 1) return;
      queueMicrotask(async () => {
        const reads = previewReads;
        previewReads = [];
        try {
          const values = await operate(database => {
            const libraryId = rows(database, "SELECT value FROM meta WHERE key='libraryId'")[0].value;
            return reads.map(read => ({ image: rows(database, `SELECT image FROM ${read.table} WHERE resource_id=?`, [read.id])[0]?.image, libraryId }));
          }, false, false);
          reads.forEach((read, index) => read.resolve(values[index]));
        } catch (error) { reads.forEach(read => read.reject(error)); }
      });
    });
  }
  const library = {
    getId: () => operate(database => rows(database, "SELECT value FROM meta WHERE key='libraryId'")[0].value, false, false),
    listCollections: () => operate(database => rows(database, `SELECT c.id, c.name, COUNT(n.id) AS count FROM collections c
      LEFT JOIN collection_resources cr ON cr.collection_id=c.id
      LEFT JOIN resources r ON r.id=cr.resource_id AND r.status='ready'
      LEFT JOIN nodes n ON n.id=r.bookmark_id AND n.present=1
      GROUP BY c.id ORDER BY c.name COLLATE NOCASE`), false, false),
    createCollection: name => operate(async database => {
      name = collectionName(name);
      if (rows(database, "SELECT id FROM collections WHERE name=?", [name]).length) throw new Error(t("Подборка с таким названием уже существует"));
      const id = crypto.randomUUID();
      database.run("INSERT INTO collections VALUES (?, ?)", [id, name]);
      await saveCatalog(root, database);
      return { id, name, count: 0 };
    }, false, false),
    renameCollection: (id, name) => operate(async database => {
      name = collectionName(name);
      if (typeof id !== "string" || !rows(database, "SELECT id FROM collections WHERE id=?", [id]).length) throw new Error(t("Подборка не найдена"));
      if (rows(database, "SELECT id FROM collections WHERE name=? AND id<>?", [name, id]).length) throw new Error(t("Подборка с таким названием уже существует"));
      database.run("UPDATE collections SET name=? WHERE id=?", [name, id]);
      await saveCatalog(root, database);
      return { id, name };
    }, false, false),
    deleteCollection: id => operate(async database => {
      if (typeof id !== "string" || !rows(database, "SELECT id FROM collections WHERE id=?", [id]).length) throw new Error(t("Подборка не найдена"));
      database.run("DELETE FROM collection_resources WHERE collection_id=?", [id]);
      database.run("DELETE FROM collections WHERE id=?", [id]);
      await saveCatalog(root, database);
    }, false, false),
    removeFromCollection: (collectionId, resourceIds) => operate(async database => {
      if (typeof collectionId !== "string" || !rows(database, "SELECT id FROM collections WHERE id=?", [collectionId]).length) throw new Error(t("Подборка не найдена"));
      for (const id of collectionResourceIds(resourceIds)) database.run("DELETE FROM collection_resources WHERE collection_id=? AND resource_id=?", [collectionId, id]);
      await saveCatalog(root, database);
    }, false, false),
    addToCollection: (collectionId, resourceIds) => operate(async database => {
      if (typeof collectionId !== "string" || !rows(database, "SELECT id FROM collections WHERE id=?", [collectionId]).length) throw new Error(t("Подборка не найдена"));
      const ids = collectionResourceIds(resourceIds);
      if (ids.some(id => !rows(database, "SELECT id FROM resources WHERE id=? AND status='ready'", [id]).length)) throw new Error(t("Ресурс не найден или загрузка не завершена"));
      for (const id of ids) database.run("INSERT OR IGNORE INTO collection_resources VALUES (?, ?)", [collectionId, id]);
      await saveCatalog(root, database);
    }, false, false),
    sync: () => operate((database, warnings) => ({ warnings, pending: rows(database, "SELECT id FROM resources WHERE status='pending'").length,
      cleanup: rows(database, "SELECT resource_id FROM cleanup").length + rows(database, "SELECT relative_path FROM stale_folders").length })),
    getBookmark: chromeId => operate((database, warnings) => {
      const bookmark = currentBookmark(database, chromeId);
      return { warnings, tags: rows(database, "SELECT tag FROM bookmark_tags WHERE bookmark_id=? ORDER BY tag", [bookmark.id]).map(row => row.tag),
        resources: rows(database, "SELECT r.*, n.chrome_id, n.title, n.url FROM resources r JOIN nodes n ON n.id=r.bookmark_id WHERE bookmark_id=? ORDER BY created_at, r.id", [bookmark.id]).map(resourceRecord) };
    }, true),
    setTags: (chromeId, tags) => operate(async database => {
      if (!Array.isArray(tags) || tags.length > 100 || tags.some(tag => typeof tag !== "string" || tag.length > 100)) throw new Error(t("Допускается до 100 тегов длиной до 100 символов"));
      const normalized = [...new Set(tags.map(tag => tag.trim().normalize("NFC").toLowerCase()).filter(Boolean))];
      const bookmark = currentBookmark(database, chromeId);
      database.run("DELETE FROM bookmark_tags WHERE bookmark_id=?", [bookmark.id]);
      for (const tag of normalized) database.run("INSERT INTO bookmark_tags VALUES (?, ?)", [bookmark.id, tag]);
      await saveCatalog(root, database);
    }),
    attach: (chromeId, files) => operate(async database => {
      if (!Array.isArray(files) || !files.length || files.some(file => !(file instanceof Blob) || typeof file.name !== "string")) throw new Error(t("Выберите файлы для загрузки"));
      const bookmark = currentBookmark(database, chromeId);
      const nodes = new Map(rows(database, "SELECT * FROM nodes").map(node => [node.id, node]));
      for (const file of files) {
        const id = crypto.randomUUID();
        const extension = file.name.match(/\.([a-zA-Z0-9]{1,12})$/)?.[1].toLowerCase();
        const path = [...bookmarkDirectory(bookmark, nodes), `r_${id}${extension ? `.${extension}` : ""}`].join("/");
        database.run("INSERT INTO resources VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')", [id, bookmark.id, file.name, file.type, file.size, new Date().toISOString(), path]);
        await saveCatalog(root, database);
        const destination = await resourceHandle(root, path, true);
        await writeFile(destination, file);
        if ((await destination.getFile()).size !== file.size) throw new Error(t("Не удалось сохранить файл: $1", [file.name]));
        database.run("UPDATE resources SET status='ready' WHERE id=?", [id]);
        await saveCatalog(root, database);
        if (file.type.startsWith("video/") && globalThis.chrome?.runtime?.sendMessage) {
          await downloadCall("prepare-previews", { resourceIds: [id] }).catch(error => console.warn(t("Не удалось запустить фоновую подготовку превью"), error));
        }
      }
    }),
    listResources: (query = {}) => operate(database => {
      const clauses = ["r.status='ready'", "n.present=1"];
      const parameters = [];
      if (query.bookmarkId !== undefined) { clauses.push("n.chrome_id=?"); parameters.push(query.bookmarkId); }
      if (query.collectionId !== undefined) {
        if (typeof query.collectionId !== "string") throw new Error(t("Некорректная подборка"));
        clauses.push("EXISTS (SELECT 1 FROM collection_resources cr WHERE cr.resource_id=r.id AND cr.collection_id=?)");
        parameters.push(query.collectionId);
      }
      if (query.tag !== undefined) {
        clauses.push("EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id=n.id AND t.tag=?)");
        parameters.push(query.tag.trim().normalize("NFC").toLowerCase());
      }
      if (query.folderId !== undefined) {
        clauses.push(`n.parent_id IN (WITH RECURSIVE subtree(id) AS (
          SELECT id FROM nodes WHERE chrome_id=? AND kind='folder' AND present=1
          UNION SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id=s.id WHERE n.kind='folder' AND n.present=1
        ) SELECT id FROM subtree)`);
        parameters.push(query.folderId);
      }
      const tags = new Map();
      for (const row of rows(database, "SELECT bookmark_id, tag FROM bookmark_tags ORDER BY tag")) {
        if (!tags.has(row.bookmark_id)) tags.set(row.bookmark_id, []);
        tags.get(row.bookmark_id).push(row.tag);
      }
      return rows(database, `SELECT r.*, n.chrome_id, n.title, n.url FROM resources r JOIN nodes n ON n.id=r.bookmark_id WHERE ${clauses.join(" AND ")} ORDER BY r.created_at, r.id`, parameters)
        .map(row => ({ ...resourceRecord(row), tags: tags.get(row.bookmark_id) || [] }));
    }, true),
    setPreview: (id, image, overwrite = true) => operate(async database => {
      const resource = rows(database, "SELECT media_type FROM resources WHERE id=? AND status='ready'", [id])[0];
      if (!resource?.media_type.startsWith("video/")) throw new Error(t("Превью можно установить только для видео"));
      if (!(image instanceof Blob) || image.type !== "image/jpeg" || !image.size || image.size > 512 * 1024) throw new Error(t("Некорректное изображение превью"));
      const bytes = new Uint8Array(await image.arrayBuffer());
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error(t("Превью должно быть изображением JPEG"));
      database.run(`INSERT INTO resource_previews VALUES (?, ?) ON CONFLICT(resource_id) DO ${overwrite ? "UPDATE SET image=excluded.image" : "NOTHING"}`, [id, bytes]);
      await saveCatalog(root, database);
    }, false, false),
    getThumbnail: async id => {
      const cached = await readCachedPreview("resource_previews", id);
      if (cached.image) return new Blob([cached.image], { type: "image/jpeg" });
      const key = `${cached.libraryId}/${id}`;
      if (!thumbnailRequests.has(key)) {
        const request = (async () => {
          const file = await library.getFile(id);
          if (!file.type.startsWith("video/")) throw new Error(t("Ресурс не является видео"));
          const image = await createVideoThumbnail(file);
          await library.setPreview(id, image, false);
          return library.getPreview(id);
        })().finally(() => thumbnailRequests.delete(key));
        thumbnailRequests.set(key, request);
      }
      return thumbnailRequests.get(key);
    },
    getTimelapse: async id => {
      const cached = await readCachedPreview("resource_timelapses", id);
      if (cached.image) return new Blob([cached.image], { type: "image/jpeg" });
      const key = `timelapse/${cached.libraryId}/${id}`;
      if (!thumbnailRequests.has(key)) {
        const request = (async () => {
          const file = await library.getFile(id);
          if (!file.type.startsWith("video/")) throw new Error(t("Ресурс не является видео"));
          const image = await createVideoTimelapse(file);
          if (image.size > 2 * 1024 * 1024) throw new Error(t("Таймлапс превышает допустимый размер кеша"));
          const bytes = new Uint8Array(await image.arrayBuffer());
          return operate(async database => {
            database.run("INSERT OR IGNORE INTO resource_timelapses VALUES (?, ?)", [id, bytes]);
            await saveCatalog(root, database);
            return new Blob([rows(database, "SELECT image FROM resource_timelapses WHERE resource_id=?", [id])[0].image], { type: "image/jpeg" });
          }, false, false);
        })().finally(() => thumbnailRequests.delete(key));
        thumbnailRequests.set(key, request);
      }
      return thumbnailRequests.get(key);
    },
    getPreview: async id => {
      const cached = await readCachedPreview("resource_previews", id);
      return cached.image ? new Blob([cached.image], { type: "image/jpeg" }) : null;
    },
    getFile: id => operate(async database => {
      const resource = rows(database, "SELECT * FROM resources WHERE id=? AND status='ready'", [id])[0];
      if (!resource) throw new Error(t("Ресурс не найден или загрузка не завершена"));
      let file;
      try { file = await (await resourceHandle(root, resource.relative_path)).getFile(); }
      catch (error) { if (error.name !== "NotFoundError") throw error; }
      if (!file || file.size !== resource.size) {
        for (const old of rows(database, "SELECT relative_path FROM cleanup WHERE resource_id=?", [id])) {
          try {
            const candidate = await (await resourceHandle(root, old.relative_path)).getFile();
            if (candidate.size === resource.size) { file = candidate; break; }
          } catch (error) { if (error.name !== "NotFoundError") throw error; }
        }
      }
      if (!file || file.size !== resource.size) throw new Error(t("Файл отсутствует или его размер изменён на диске"));
      return new File([file], resource.name, { type: resource.media_type, lastModified: file.lastModified });
    }, true)
  };
  return library;
}
