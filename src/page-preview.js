import { t } from "./i18n.js";
import { hostPattern, downloadFrameBlob } from "./media-scan.js";
import { youtubeVideoId } from "./youtube-preview.js";
import { downloadCall } from "./extension-bridge.js";

let stopCurrent;

export function mountVideoPreview(container, candidate, tabId, label) {
  const video = document.createElement("video");
  video.setAttribute("aria-label", t("Превью: $1", [label]));
  video.playsInline = true;
  video.muted = true;
  video.loop = true;
  video.preload = "none";
  if (candidate.poster) video.poster = candidate.poster;
  const play = document.createElement("button");
  play.type = "button";
  play.className = "settings-button preview-play";
  play.textContent = t("Воспроизвести");
  play.setAttribute("aria-label", t("Воспроизвести превью: $1", [label]));
  const message = document.createElement("span");
  message.className = "preview-message";
  message.setAttribute("role", "status");
  let controller;
  let disposed = false;
  let objectUrl;
  let youtubeFrame;
  const youtubeId = candidate.transport === "blob" ? youtubeVideoId(candidate.frameUrl) : null;
  const disclosure = youtubeId ? t("Превью откроет плеер YouTube. Google получит IP-адрес, параметры запроса и идентификатор расширения. Загрузка видео недоступна.") : "";
  message.textContent = disclosure;
  let origins = [];
  const stop = () => {
    controller?.abort();
    youtubeFrame?.remove();
    youtubeFrame = undefined;
    video.hidden = false;
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
    play.hidden = false;
    video.controls = false;
    message.textContent = disclosure;
  };
  const activate = () => {
    if (stopCurrent !== stop) stopCurrent?.();
    stopCurrent = stop;
  };
  video.addEventListener("play", activate);
  const failed = text => {
    message.textContent = text;
    play.hidden = false;
    video.controls = false;
  };
  video.addEventListener("error", () => {
    if (!disposed && !controller?.signal.aborted) failed(t("Не удалось воспроизвести видео. Источник или кодек недоступен."));
  });
  play.addEventListener("click", async () => {
    if (play.disabled || disposed) return;
    const access = chrome.permissions.request({
      origins: [...new Set([youtubeId ? "https://www.youtube.com/*" : hostPattern(candidate.transport === "blob" ? candidate.origin : candidate.url), ...origins])],
      ...(youtubeId ? { permissions: ["declarativeNetRequestWithHostAccess"] } : {})
    });
    activate();
    controller = new AbortController();
    const signal = controller.signal;
    play.disabled = true;
    message.textContent = t("Подготовка превью…");
    try {
      if (!await access) throw new Error(t("Доступ к сайту с видео не предоставлен"));
      signal.throwIfAborted();
      if (youtubeId) {
        const url = await downloadCall("youtube-preview", { id: youtubeId });
        signal.throwIfAborted();
        youtubeFrame = document.createElement("iframe");
        youtubeFrame.title = `YouTube: ${label}`;
        youtubeFrame.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
        youtubeFrame.allowFullscreen = true;
        youtubeFrame.referrerPolicy = "strict-origin-when-cross-origin";
        youtubeFrame.src = url;
        video.hidden = true;
        play.hidden = true;
        message.textContent = "";
        container.append(youtubeFrame);
        return;
      }
      let file;
      const options = { signal, onProgress: text => { if (!disposed && !signal.aborted) message.textContent = text; } };
      if (["hls", "dash"].includes(candidate.transport)) {
        const { downloadStream } = await import("./stream-download.js");
        file = await downloadStream(candidate, { ...options, preview: true });
      } else if (candidate.transport === "blob") file = await downloadFrameBlob(tabId, candidate, { ...options, byteLimit: 64 * 1024 * 1024 });
      signal.throwIfAborted();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = file ? URL.createObjectURL(file) : undefined;
      video.src = objectUrl || candidate.url;
      video.controls = true;
      play.hidden = true;
      message.textContent = ["hls", "dash"].includes(candidate.transport) ? t("Превью: первые 30 секунд доступного фрагмента.") : "";
      await video.play();
    } catch (error) {
      if (disposed) return;
      if (signal.aborted) { play.hidden = false; message.textContent = ""; }
      else {
        origins = Array.isArray(error.origins) ? error.origins : [];
        play.textContent = origins.length ? t("Разрешить доступ и воспроизвести") : t("Воспроизвести");
        play.setAttribute("aria-label", t("$1 превью: $2", [play.textContent, label]));
        failed(origins.length ? t("Для превью нужен доступ к доменам потока.") : error.message);
      }
    } finally { play.disabled = false; }
  });
  container.append(video, play, message);
  return () => {
    disposed = true;
    stop();
    if (stopCurrent === stop) stopCurrent = undefined;
  };
}
