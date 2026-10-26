import { t } from "./i18n.js";
import { sharedLibraryContext, sharedLibraryCall, sharedDirectory } from "./shared-library-client.js";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bookmark-resources", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getResourceDirectory() {
  if (sharedLibraryContext()) return sharedDirectory(await sharedLibraryCall("directory"));
  return readSetting("resourceDirectory");
}

export async function getResourceDirectoryInfo() {
  return navigator.locks.request("bookmark-resource-library", async () => {
    const directory = await readSetting("resourceDirectory");
    if (!directory) return null;
    let id = await readSetting("resourceDirectoryId");
    if (!id) { id = crypto.randomUUID(); await writeSetting("resourceDirectoryId", id); }
    return { id, name: directory.name, permission: await directory.queryPermission({ mode: "readwrite" }) };
  });
}

export async function getDownloadDirectory(id) {
  const selected = await readSetting(`downloadDirectory/${id}`) || await readSetting("downloadDirectory");
  if (selected?.directory?.sharedLibraryId) selected.directory = sharedDirectory({ id: selected.directory.sharedLibraryId, name: selected.directory.name });
  return selected;
}
export function setDownloadDirectory(id, directory) {
  const stored = directory.sharedLibraryId ? { sharedLibraryId: directory.sharedLibraryId, name: directory.name } : directory;
  return writeSetting(`downloadDirectory/${id}`, { id, directory: stored });
}

async function readSetting(key) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction("settings").objectStore("settings").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export async function setResourceDirectory(directory) {
  if (sharedLibraryContext()) throw new Error(t("Общая папка ресурсов выбирается в обычном окне Chrome"));
  const save = () => saveResourceDirectory(directory);
  return globalThis.navigator?.locks ? navigator.locks.request("bookmark-resource-library", save) : save();
}

async function saveResourceDirectory(directory) {
  await writeSettings([["resourceDirectory", directory], ["resourceDirectoryId", crypto.randomUUID()]]);
  try { await globalThis.chrome?.storage?.local?.set({ resourceCounts: {} }); }
  catch (error) { console.warn(t("Не удалось сбросить счётчик ресурсов на значке"), error); }
}

const writeSetting = (key, value) => writeSettings([[key, value]]);

async function writeSettings(entries) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("settings", "readwrite");
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error(t("Сохранение папки отменено")));
      for (const [key, value] of entries) transaction.objectStore("settings").put(value, key);
    });
  } finally {
    database.close();
  }
}
