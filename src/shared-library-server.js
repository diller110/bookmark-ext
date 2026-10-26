import { t } from "./i18n.js";
import { getResourceDirectory, getResourceDirectoryInfo } from "./resource-directory.js";
import { openResourceLibrary } from "./resource-library.js";

const transfers = new Map();
export let sharedLibraryUsed = false;
export let sharedLibraryBusy = 0;

function transfer(id) {
  const entry = transfers.get(id);
  if (!entry) throw new Error(t("Передача файла прервана. Повторите действие."));
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => transfers.delete(id), 120000);
  return entry;
}

export async function handleSharedLibrary({ operation, args = [], directoryId }) {
  const info = await getResourceDirectoryInfo();
  if (operation === "directory") return info;
  if (!info || info.id !== directoryId) throw new Error(t("Папка ресурсов изменена в обычном окне. Обновите список ресурсов."));
  const library = await openResourceLibrary(await getResourceDirectory());
  if (["getId", "sync", "getBookmark", "listResources", "setTags", "listCollections", "createCollection", "renameCollection", "deleteCollection", "removeFromCollection", "addToCollection"].includes(operation)) return library[operation](...args);
  if (["getFile", "getPreview", "getThumbnail", "getTimelapse"].includes(operation)) {
    const file = await library[operation](...args);
    if (!file) return null;
    const id = crypto.randomUUID();
    transfers.set(id, { file }); transfer(id);
    return { id, name: file.name || "preview.jpg", type: file.type, size: file.size, lastModified: file.lastModified };
  }
  if (operation === "read") {
    const file = transfer(args[0]).file;
    const offset = args[1];
    if (!file || !Number.isSafeInteger(offset) || offset < 0 || offset >= file.size) throw new Error(t("Некорректный фрагмент файла"));
    const bytes = new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return btoa(binary);
  }
  if (operation === "upload") {
    const files = args[0];
    if (!Array.isArray(files) || !files.length || files.length > 100 || files.some(file => typeof file.name !== "string" || typeof file.type !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 512 * 1024 * 1024)) throw new Error(t("Некорректные файлы ресурсов"));
    const id = crypto.randomUUID();
    transfers.set(id, { files: files.map(file => ({ ...file, chunks: [], loaded: 0 })) }); transfer(id);
    return id;
  }
  if (operation === "write") {
    const file = transfer(args[0]).files?.[args[1]];
    if (!file || typeof args[2] !== "string" || args[2].length > 350000) throw new Error(t("Некорректный фрагмент ресурса"));
    const bytes = Uint8Array.from(atob(args[2]), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length > 256 * 1024 || file.loaded + bytes.length > file.size) throw new Error(t("Неверный размер фрагмента ресурса"));
    file.chunks.push(bytes); file.loaded += bytes.length;
    return null;
  }
  if (["attach", "setPreview"].includes(operation)) {
    const files = transfer(args[1]).files;
    if (!files || files.some(file => file.size !== file.loaded)) throw new Error(t("Передача ресурса не завершена"));
    const loaded = files.map(file => new File(file.chunks, file.name, { type: file.type }));
    return library[operation](args[0], operation === "attach" ? loaded : loaded[0]);
  }
  if (operation === "release") {
    clearTimeout(transfers.get(args[0])?.timer);
    transfers.delete(args[0]);
    return null;
  }
  throw new Error(t("Неизвестная операция библиотеки"));
}

export function registerSharedLibrary() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "shared-library") return;
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("src/background.js")) return;
    sharedLibraryUsed = true;
    sharedLibraryBusy++;
    handleSharedLibrary(message.payload).then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: error.message })).finally(() => {
      sharedLibraryBusy--;
      chrome.runtime.sendMessage({ target: "download-background", type: "release", payload: {} }).catch(console.warn);
    });
    return true;
  });
}
