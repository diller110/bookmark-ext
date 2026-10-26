import { t } from "./i18n.js";
async function withVideo(file, render) {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.preload = "auto";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(t("Не удалось получить кадр видео за 15 секунд"))), 15000);
      const finish = error => {
        clearTimeout(timer);
        video.onloadedmetadata = video.onseeked = video.onerror = null;
        error ? reject(error) : resolve();
      };
      video.onloadedmetadata = () => { video.currentTime = Number.isFinite(video.duration) ? Math.min(0.1, video.duration / 2) : 0.1; };
      video.onseeked = () => finish();
      video.onerror = () => finish(new Error(t("Не удалось прочитать видео: $1", [video.error?.message || t("формат не поддерживается браузером")])));
      video.src = url;
    });
    return await render(video);
  } finally {
    video.pause(); video.removeAttribute("src"); video.load();
    URL.revokeObjectURL(url);
  }
}

export function createVideoThumbnail(file) {
  return withVideo(file, async video => {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.8));
    if (!image) throw new Error(t("Не удалось создать превью видео"));
    return image;
  });
}

export function createVideoTimelapse(file) {
  return withVideo(file, async video => {
    const seek = time => new Promise((resolve, reject) => {
      if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2) { resolve(); return; }
      const timer = setTimeout(() => finish(new Error(t("Не удалось прочитать кадр таймлапса"))), 15000);
      const finish = error => {
        clearTimeout(timer);
        video.onseeked = video.onerror = null;
        error ? reject(error) : resolve();
      };
      video.onseeked = () => finish();
      video.onerror = () => finish(new Error(t("Не удалось декодировать видео")));
      video.currentTime = time;
    });
    // Recorded WebM can reveal its duration only after seeking to the end.
    if (!Number.isFinite(video.duration)) await seek(1e10);
    const duration = Number.isFinite(video.duration) ? video.duration : video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    if (!(duration > 0 && Number.isFinite(duration))) throw new Error(t("Не удалось определить длительность видео"));
    const scale = Math.min(1, 360 / video.videoWidth, 220 / video.videoHeight);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width * 4; canvas.height = height * 3;
    const context = canvas.getContext("2d");
    for (let frame = 0; frame < 12; frame++) {
      await seek((frame + 0.5) * duration / 12);
      context.drawImage(video, frame % 4 * width, Math.floor(frame / 4) * height, width, height);
    }
    const image = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.7));
    if (!image) throw new Error(t("Не удалось создать таймлапс"));
    return image;
  });
}
