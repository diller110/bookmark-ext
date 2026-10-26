import { t } from "./i18n.js";
export function assertDownloadSource(value) {
  if (!value) return;
  let host;
  try {
    const url = new URL(value);
    host = (url.protocol === "blob:" ? new URL(url.origin) : url).hostname.toLowerCase().replace(/\.$/, "");
  } catch { return; }
  if (["youtube.com", "youtu.be", "youtube-nocookie.com", "googlevideo.com"].some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error(t("Загрузка видео YouTube не поддерживается. Доступно только встроенное превью."));
  }
}

export function assertDownloadJob(job) {
  for (const value of [job.url, job.candidate?.frameUrl, job.candidate?.url]) assertDownloadSource(value);
}
