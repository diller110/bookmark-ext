import { t } from "./i18n.js";
import { collectPageMedia, pageMediaCandidates, pageMediaMessages } from "./page-media.js";

export function hostPattern(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(t("Недопустимый адрес сайта с медиа"));
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export async function scanTabMedia(tab) {
  const frames = chrome.webNavigation ? await chrome.webNavigation.getAllFrames({ tabId: tab.id }) : [{ frameId: 0, url: tab.url }];
  const found = [];
  const missing = new Set();
  const failures = [];
  const originOf = (frame, seen = new Set()) => {
    if (!frame || seen.has(frame.frameId)) return "";
    seen.add(frame.frameId);
    try {
      if (/^https?:/.test(frame.url)) return new URL(frame.url).origin;
      if (/^about:(blank|srcdoc)/.test(frame.url)) return originOf(frames.find(parent => parent.frameId === frame.parentFrameId), seen);
    } catch { /* Ignore inaccessible frames. */ }
    return "";
  };
  for (const frame of frames || []) {
    const origin = originOf(frame);
    if (!origin) continue;
    if (origin !== new URL(tab.url).origin && !await chrome.permissions.contains({ origins: [hostPattern(origin)] })) {
      missing.add(hostPattern(origin)); continue;
    }
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frame.frameId] }, func: collectPageMedia, args: [frame.url, false, pageMediaMessages()] });
      found.push(...pageMediaCandidates(result.result, { frameId: frame.frameId, frameUrl: frame.url, origin }));
    } catch (error) { failures.push(error.message); }
  }
  found.sort((a, b) => b.pageArea - a.pageArea);
  const videos = found.filter(item => item.kind === "video");
  const candidates = videos.length ? videos.filter((item, index) => !videos.slice(0, index).some(other => item.url && other.url === item.url))
    : found.slice(0, 1);
  return { candidates, missing: [...missing], failures };
}

// Executed in the owning frame's isolated world; only bounded chunks cross Chrome IPC.
export async function readFrameBlob(url, expectedUrl, id, offset, remove = false, messages = {}) {
  const t = source => messages[source] || source;
  try {
    if (location.href !== expectedUrl) throw new Error(t("Адрес фрейма изменился"));
    const blobs = globalThis.__bookmarkResourceBlobs ||= new Map();
    if (remove) { clearTimeout(blobs.get(id)?.timer); blobs.delete(id); return; }
    if (!blobs.has(id)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(t("Blob недоступен"));
      const blob = await response.blob();
      if (!blob.type.startsWith("video/") || !blob.size) throw new Error(t("Blob не содержит готового видеофайла"));
      blobs.set(id, { blob });
    }
    const entry = blobs.get(id);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => blobs.delete(id), 60000);
    const blob = entry.blob;
    const bytes = new Uint8Array(await blob.slice(offset, offset + 512 * 1024).arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return { chunk: btoa(binary), size: blob.size, type: blob.type };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

export async function downloadFrameBlob(tabId, candidate, { signal, onProgress = () => {}, readChunk, byteLimit = 512 * 1024 * 1024 }) {
  const id = crypto.randomUUID();
  const chunks = [];
  let size = 0;
  let type;
  const invoke = readChunk || ((offset, remove = false) => chrome.scripting.executeScript({ target: { tabId, frameIds: [candidate.frameId] }, func: readFrameBlob,
    args: [candidate.url, candidate.frameUrl, id, offset, remove, frameBlobMessages()] }));
  try {
    let total;
    do {
      signal?.throwIfAborted();
      const results = await invoke(size);
      const part = results?.[0]?.result;
      if (!part || typeof part !== "object") throw new Error(t("Фрейм не вернул данные видео. Источник мог быть закрыт или изменён"));
      if (typeof part.error === "string") throw new Error(part.error);
      if (!Number.isSafeInteger(part.size) || part.size <= 0 || part.size > byteLimit) throw new Error(t("Размер blob превышает лимит $1 МБ или файл пуст", [Math.round(byteLimit / 1024 / 1024)]));
      const bytes = Uint8Array.from(atob(part.chunk), char => char.charCodeAt(0));
      if (!bytes.length || bytes.length > 512 * 1024 || size + bytes.length > part.size || total !== undefined && total !== part.size) throw new Error(t("Некорректный фрагмент blob"));
      chunks.push(bytes); size += bytes.length; total = part.size; type = part.type;
      onProgress(t("Загрузка blob: $1 %", [Math.round(size / total * 100)]), { loadedBytes: size, totalBytes: total, totalApproximate: false });
    } while (size < total);
    if (!type?.startsWith("video/")) throw new Error(t("Blob не является видео"));
    return new File(chunks, type.includes("webm") ? "video.webm" : type.includes("mp4") ? "video.mp4" : "video.bin", { type });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(t("Не удалось прочитать blob: $1. Если плеер использует MediaSource, запустите видео и обновите список, чтобы найти HLS/DASH.", [error.message]));
  } finally { await invoke(0, true).catch(() => {}); }
}

export function frameBlobMessages() {
  return {
    "Адрес фрейма изменился": t("Адрес фрейма изменился"),
    "Blob недоступен": t("Blob недоступен"),
    "Blob не содержит готового видеофайла": t("Blob не содержит готового видеофайла"),
    direction: /^(ar|fa|he|ur)(-|$)/i.test(globalThis.chrome?.i18n?.getUILanguage() || "ru") ? "rtl" : "ltr"
  };
}
