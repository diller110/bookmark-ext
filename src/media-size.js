import { t } from "./i18n.js";
import { planStream } from "./stream-download.js";
import { hostPattern } from "./media-scan.js";
import { formatFileSize } from "./file-size.js";

export async function readMediaSize(url, expectedUrl, signal) {
  if (expectedUrl && location.href !== expectedUrl) return null;
  try {
    const timeout = AbortSignal.timeout(5000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    // This function is also injected into page frames and cannot import fetchMedia.
    try {
      response = await fetch(url, { method: "HEAD", credentials: "omit", signal: requestSignal });
      if ([401, 403].includes(response.status) || /text\/html/i.test(response.headers.get("Content-Type") || "")) {
        await response.body?.cancel().catch(() => {});
        response = undefined;
      }
    } catch (error) { if (requestSignal.aborted || !(error instanceof TypeError)) throw error; }
    response ||= await fetch(url, { method: "HEAD", credentials: "include", signal: requestSignal });
    if (!response.ok || response.headers.get("Content-Encoding") || /text\/html/i.test(response.headers.get("Content-Type") || "")) return null;
    const size = Number(response.status === 206 ? response.headers.get("Content-Range")?.match(/\/(\d+)$/)?.[1] : response.headers.get("Content-Length"));
    return Number.isSafeInteger(size) && size > 0 ? size : null;
  } catch { return null; }
}

export async function mediaSize(candidate, tabId, signal) {
  if (!candidate.url) return null;
  if (candidate.transport === "blob") return null;
  if (!["hls", "dash"].includes(candidate.transport)) {
    if (!/^https?:/.test(candidate.url)) return null;
    if (await chrome.permissions.contains({ origins: [hostPattern(candidate.url)] })) {
      const bytes = await readMediaSize(candidate.url, undefined, signal);
      if (bytes) return { bytes, approximate: false };
    }
    signal.throwIfAborted();
    const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [candidate.frameId] },
      func: readMediaSize, args: [candidate.url, candidate.frameUrl] });
    return result?.result > 0 ? { bytes: result.result, approximate: false } : null;
  }
  const plan = await planStream(candidate, { signal });
  let bytes = 0;
  for (const track of plan.tracks) {
    signal.throwIfAborted();
    if (track.file) {
      const size = await readMediaSize(track.file, undefined, signal);
      if (!size) return null;
      bytes += size;
      continue;
    }
    const segments = track.playlist.segments;
    const duration = segments.reduce((sum, segment) => sum + segment.duration, 0);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    let sampleBytes = 0;
    let sampleDuration = 0;
    for (const index of new Set([0, Math.floor(segments.length / 2), segments.length - 1])) {
      signal.throwIfAborted();
      const segment = segments[index];
      const size = segment.byterange?.length || await readMediaSize(new URL(segment.resolvedUri || segment.uri, track.base).href, undefined, signal);
      if (!size || !segment.duration) return null;
      sampleBytes += size;
      sampleDuration += segment.duration;
    }
    bytes += sampleBytes / sampleDuration * duration;
  }
  return bytes > 0 ? { bytes: Math.round(bytes), approximate: true, live: plan.live } : null;
}

export function mediaSizeLabel(size) {
  if (!size) return t("Размер неизвестен");
  return `${size.approximate ? "≈ " : ""}${formatFileSize(size.bytes)}${size.live ? t(" · доступный фрагмент") : ""}`;
}

export function downloadSizeLabel(job) {
  const loaded = job.loadedBytes > 0 ? mediaSizeLabel({ bytes: job.loadedBytes }) : t("0 Б");
  const total = job.totalBytes > 0 ? mediaSizeLabel({ bytes: job.totalBytes, approximate: job.totalApproximate }) : t("размер неизвестен");
  return `${loaded} / ${total}`;
}
