import { t } from "./i18n.js";
export const activeDownload = job => ["starting", "downloading", "saving"].includes(job?.status);
export const finishedDownload = job => ["done", "cancelled", "error", "interrupted"].includes(job?.status);
export const retryableDownload = job => ["error", "interrupted"].includes(job?.status);
export const downloadQueueKey = () => globalThis.chrome?.extension?.inIncognitoContext ? "incognitoDownloadQueue" : "downloadQueue";

export async function downloadCall(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: "download-background", type, payload });
  if (!response?.ok) throw new Error(response?.error || t("Фоновый загрузчик не ответил"));
  return response.value;
}

export function getBookmarkTree() {
  return globalThis.chrome?.bookmarks ? chrome.bookmarks.getTree() : downloadCall("tree");
}

export function setResourceCounts(resourceCounts) {
  return globalThis.chrome?.storage?.local ? chrome.storage.local.set({ resourceCounts }) : downloadCall("counts", { resourceCounts });
}

export async function allowedMediaOrigins(origins) {
  if (globalThis.chrome?.permissions?.contains) return Promise.all(origins.map(origin => chrome.permissions.contains({ origins: [origin] })));
  if (globalThis.chrome?.runtime?.sendMessage) return downloadCall("permissions", { origins });
  return origins.map(() => true);
}
