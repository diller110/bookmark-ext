import { t } from "./i18n.js";
const prefix = "shared-library/";
let sharedContext = false;
export const sharedLibraryContext = () => globalThis.chrome?.extension?.inIncognitoContext || sharedContext;

export async function sharedLibraryCall(operation, args = [], directoryId) {
  if (!chrome.storage?.local) {
    const response = await chrome.runtime.sendMessage({ target: "download-background", type: "shared-library", payload: { operation, args, directoryId } });
    if (!response?.ok) throw new Error(response?.error || t("Общая библиотека недоступна"));
    return response.value;
  }
  const key = prefix + crypto.randomUUID();
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timeout);
        chrome.storage.onChanged.removeListener(changed);
        error ? reject(new Error(error)) : resolve(value);
      };
      const changed = (changes, area) => {
        const response = changes[key]?.newValue?.response;
        if (area === "local" && response) finish(response.error, response.value);
      };
      const timeout = setTimeout(() => finish(t("Обычная часть расширения не ответила. Перезагрузите расширение в Chrome.")), 60000);
      chrome.storage.onChanged.addListener(changed);
      chrome.storage.local.set({ [key]: { request: { operation, args, directoryId }, at: Date.now() } }).catch(error => finish(error.message));
    });
  } finally { await chrome.storage.local.remove(key); }
}

export function sharedDirectory(info) {
  if (!info) return undefined;
  sharedContext = true;
  return {
    kind: "directory", name: info.name, sharedLibraryId: info.id,
    async queryPermission() {
      const current = await sharedLibraryCall("directory");
      return current?.id === info.id ? current.permission : "denied";
    },
    async requestPermission() { return this.queryPermission(); },
    async isSameEntry(other) { return other?.sharedLibraryId === info.id; }
  };
}

const encode = bytes => {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
};
const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

export function sharedLibrary(directory) {
  const call = (operation, ...args) => sharedLibraryCall(operation, args, directory.sharedLibraryId);
  async function read(operation, id) {
    const transfer = await call(operation, id);
    if (!transfer) return null;
    try {
      const chunks = [];
      for (let offset = 0; offset < transfer.size; offset += 256 * 1024) chunks.push(decode(await call("read", transfer.id, offset)));
      return new File(chunks, transfer.name, { type: transfer.type, lastModified: transfer.lastModified });
    } finally { await call("release", transfer.id).catch(() => {}); }
  }
  async function upload(files, operation, id) {
    const transfer = await call("upload", files.map(file => ({ name: file.name || "preview.jpg", type: file.type, size: file.size })));
    try {
      for (const [index, file] of files.entries()) {
        for (let offset = 0; offset < file.size; offset += 256 * 1024) {
          await call("write", transfer, index, encode(new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer())));
        }
      }
      await call(operation, id, transfer);
    } finally { await call("release", transfer).catch(() => {}); }
  }
  return {
    sync: () => call("sync"),
    getId: () => call("getId"),
    getBookmark: id => call("getBookmark", id),
    listResources: (query = {}) => call("listResources", query),
    listCollections: () => call("listCollections"),
    createCollection: name => call("createCollection", name),
    renameCollection: (id, name) => call("renameCollection", id, name),
    deleteCollection: id => call("deleteCollection", id),
    removeFromCollection: (collectionId, resourceIds) => call("removeFromCollection", collectionId, resourceIds),
    addToCollection: (collectionId, resourceIds) => call("addToCollection", collectionId, resourceIds),
    setTags: (id, tags) => call("setTags", id, tags),
    getFile: id => read("getFile", id),
    getPreview: id => read("getPreview", id),
    getThumbnail: id => read("getThumbnail", id),
    getTimelapse: id => read("getTimelapse", id),
    attach: (id, files) => upload(files, "attach", id),
    setPreview: (id, image) => upload([image], "setPreview", id)
  };
}
