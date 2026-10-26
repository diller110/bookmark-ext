import { t } from "./i18n.js";
import { formatFileSize } from "./file-size.js";
import { fetchMedia } from "./media-fetch.js";

// This function is injected into the page and must not depend on module scope.
export function collectPageMedia(expectedUrl, pick = false, messages = {}) {
  const t = source => messages[source] || source;
  if (expectedUrl && location.href !== expectedUrl) throw new Error(t("Адрес фрейма изменился. Обновите список ресурсов."));
  const area = node => { const rect = node.getBoundingClientRect?.(); return rect ? Math.max(0, rect.width) * Math.max(0, rect.height) : (node.naturalWidth || node.videoWidth || 0) * (node.naturalHeight || node.videoHeight || 0); };
  function collect(root = document, manual = false) {
    const videos = [...(root.matches?.("video") ? [root] : root.querySelectorAll("video"))].map(video => {
      const sources = [...video.querySelectorAll("source")];
      const direct = sources.find(source => /^https?:/.test(source.src));
      const url = /^https?:/.test(video.currentSrc || video.src) ? video.currentSrc || video.src : direct?.src || video.currentSrc || video.src;
      let poster = video.poster;
      if (!poster && video.readyState >= 2) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 320; canvas.height = Math.max(1, Math.round(320 * video.videoHeight / video.videoWidth));
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          poster = canvas.toDataURL("image/png");
        } catch { /* Cross-origin frames may not be readable as pixels. */ }
      }
      return { kind: "video", url, poster, width: video.videoWidth, height: video.videoHeight, pageArea: area(video),
        type: sources.find(source => source.src === url)?.type || "" };
    });
    const needsManifest = (!manual && !videos.length) || videos.some(video => !video.url || video.url.startsWith("blob:"));
    const manifests = needsManifest ? [...new Set((globalThis.performance?.getEntriesByType("resource") || []).map(entry => entry.name)
      .filter(url => /^https?:/.test(url) && /\.(m3u8|mpd)(?:[?#]|$)/i.test(url)))] : [];
    for (const url of manifests) {
      if (!videos.some(video => video.url === url)) videos.push({ ...videos[0], kind: "video", url, type: /\.mpd(?:[?#]|$)/i.test(url) ? "application/dash+xml" : "application/vnd.apple.mpegurl" });
    }
    const found = manifests.length ? videos.filter(video => !video.url?.startsWith("blob:")) : videos;
    if (found.length) return found.sort((a, b) => b.pageArea - a.pageArea).filter((video, index, sorted) => !sorted.slice(0, index).some(other => video.url && other.url === video.url));
    let largest;
    for (const image of root === document ? document.images : root.matches?.("img") ? [root] : root.querySelectorAll("img")) {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const url = image.currentSrc || image.src;
      const pageArea = area(image);
      if (url && (!largest || pageArea > largest.pageArea)) largest = { kind: "image", url, width, height, pageArea, type: "", poster: "" };
    }
    if (!largest && manual) {
      const match = getComputedStyle(root).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
      if (match) { const rect = root.getBoundingClientRect(); largest = { kind: "image", url: match[1], width: rect.width, height: rect.height, pageArea: area(root) }; }
    }
    return largest ? [largest] : [];
  }
  if (!pick) return collect();
  globalThis.__bookmarkMediaPicker?.();
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    const shadow = overlay.attachShadow({ mode: "closed" });
    shadow.innerHTML = '<style>div{position:fixed;pointer-events:none;box-sizing:border-box}#box{border:2px solid #8ab4f8;background:#8ab4f822;border-radius:4px}#hint{top:12px;left:12px;max-width:calc(100vw - 24px);padding:12px 16px;border-radius:8px;background:#292a2d;color:#e8eaed;font:15px "Segoe UI",sans-serif;box-shadow:0 2px 12px #0008}</style><div id="box"></div><div id="hint"></div>';
    document.documentElement.append(overlay);
    shadow.querySelector("#hint").textContent = t("Наведите на ресурс и нажмите · Esc — отмена. Затем откройте расширение.");
    shadow.host.dir = messages.direction || "ltr";
    const box = shadow.querySelector("#box");
    let selected;
    const move = event => {
      selected = event.composedPath().find(node => node instanceof Element && node.matches("video,img")) || event.target;
      const rect = selected.getBoundingClientRect();
      Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    const finish = (result = []) => {
      clearTimeout(timer); overlay.remove();
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      delete globalThis.__bookmarkMediaPicker;
      resolve(result);
    };
    const click = event => {
      event.preventDefault(); event.stopImmediatePropagation();
      move(event);
      let result = [];
      for (let node = selected; node; node = node.parentElement) {
        result = collect(node, true);
        if (result.length) break;
      }
      if (result.length) finish(result);
      else shadow.querySelector("#hint").textContent = t("В элементе и его родителях медиа не найдено. Выберите другой элемент · Esc — отмена");
    };
    const key = event => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(); } };
    const timer = setTimeout(() => finish(), 120000);
    globalThis.__bookmarkMediaPicker = finish;
    document.addEventListener("pointermove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
  });
}

export function mediaUrl(value, image = false) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
    if (image && /^data:image\/(png|jpeg|webp|gif|avif|bmp);/i.test(value)) return value;
  } catch { /* Page attributes are untrusted. */ }
  return null;
}

export function pageMediaCandidates(value, frame = {}) {
  if (!Array.isArray(value)) throw new Error(t("Страница вернула некорректный список медиа"));
  return value.filter(item => item && ["image", "video"].includes(item.kind)).map(item => {
    let url = mediaUrl(item.url, item.kind === "image");
    if (!url && item.kind === "video" && typeof item.url === "string" && item.url.startsWith("blob:") && Number.isInteger(frame.frameId)) {
      try { if (new URL(item.url).origin === frame.origin) url = item.url; } catch { /* Invalid blob URL. */ }
    }
    const transport = url?.startsWith("blob:") ? "blob" : /\.mpd(?:[?#]|$)/i.test(url) || /dash\+xml/i.test(item.type) ? "dash"
      : /\.m3u8(?:[?#]|$)/i.test(url) || /mpegurl/i.test(item.type) ? "hls" : "file";
    return { kind: item.kind, url, poster: mediaUrl(item.poster, true),
      width: Number.isFinite(item.width) && item.width > 0 ? item.width : 0,
      height: Number.isFinite(item.height) && item.height > 0 ? item.height : 0,
      pageArea: Number.isFinite(item.pageArea) && item.pageArea >= 0 ? item.pageArea : 0,
      type: typeof item.type === "string" ? item.type : "", downloadable: Boolean(url), transport, ...frame };
  });
}

export async function fetchPageMedia(candidate, { signal, onProgress, byteLimit = 512 * 1024 * 1024 } = {}) {
  if (!candidate.downloadable) throw new Error(t("У этого видео нет доступной прямой ссылки на файл"));
  const response = await fetchMedia(candidate.url, { signal });
  if (!response.ok) throw new Error(t("Сайт не отдал файл (HTTP $1)", [response.status]));
  const tooLarge = () => new Error(t("Размер файла превышает лимит $1", [formatFileSize(byteLimit)]));
  if (Number(response.headers.get("Content-Length")) > byteLimit && !response.headers.get("Content-Encoding")) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  let blob;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks = [];
    const total = Number(response.headers.get("Content-Length"));
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        signal?.throwIfAborted();
        size += value.length;
        if (size > byteLimit) throw tooLarge();
        chunks.push(value);
        onProgress?.(total > 0 ? t("Загружено: $1 %", [Math.min(100, Math.round(size / total * 100))]) : t("Загружено: $1", [formatFileSize(size)]),
          { loadedBytes: size, totalBytes: Number.isSafeInteger(total) && total > 0 && !response.headers.get("Content-Encoding") ? total : null, totalApproximate: false });
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    blob = new Blob(chunks, { type: response.headers.get("Content-Type") || "" });
  } else blob = await response.blob();
  if (blob.size > byteLimit) throw tooLarge();
  if (!blob.size) throw new Error(t("Сайт вернул пустой файл"));
  let type = blob.type.split(";")[0].toLowerCase();
  if (!type || type === "application/octet-stream") {
    const extension = new URL(candidate.url).pathname.split(".").pop().toLowerCase();
    type = ({ mp4: "video/mp4", webm: "video/webm", ogg: "video/ogg", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" })[extension] || candidate.type.split(";")[0].toLowerCase();
  }
  if (candidate.kind !== "file" && !type.startsWith(`${candidate.kind}/`)) throw new Error(t("Вместо медиа сайт вернул другой тип файла. Возможно, требуется авторизация или прямая ссылка недоступна."));
  type ||= "application/octet-stream";
  let name;
  try { name = decodeURIComponent(new URL(candidate.url).pathname.split("/").pop()); } catch { /* Use a fallback name. */ }
  if (!name || new URL(candidate.url).protocol === "data:") name = candidate.kind === "file" ? "file" : candidate.kind === "video" ? "video" : "image";
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 180);
  const extension = ({ "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogg", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg" })[type];
  if (extension && !name.toLowerCase().endsWith(`.${extension}`) && !(type === "image/jpeg" && /\.jpeg$/i.test(name))) name += `.${extension}`;
  return new File([blob], name, { type });
}

export function pageMediaMessages() {
  return {
    "Адрес фрейма изменился. Обновите список ресурсов.": t("Адрес фрейма изменился. Обновите список ресурсов."),
    "Наведите на ресурс и нажмите · Esc — отмена. Затем откройте расширение.": t("Наведите на ресурс и нажмите · Esc — отмена. Затем откройте расширение."),
    "В элементе и его родителях медиа не найдено. Выберите другой элемент · Esc — отмена": t("В элементе и его родителях медиа не найдено. Выберите другой элемент · Esc — отмена"),
    direction: /^(ar|fa|he|ur)(-|$)/i.test(globalThis.chrome?.i18n?.getUILanguage() || "ru") ? "rtl" : "ltr"
  };
}
