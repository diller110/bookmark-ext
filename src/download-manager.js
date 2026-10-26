import { t } from "./i18n.js";
import { getResourceDirectory, setDownloadDirectory } from "./resource-directory.js";
import { pageMediaCandidates, mediaUrl } from "./page-media.js";
import { readFrameBlob, hostPattern, frameBlobMessages } from "./media-scan.js";
import { activeDownload, finishedDownload, retryableDownload, downloadQueueKey } from "./extension-bridge.js";
import { prepareYoutubePreview } from "./youtube-preview.js";
import { sharedLibraryCall } from "./shared-library-client.js";
import { assertDownloadJob } from "./download-policy.js";

let creating;

async function hasWorker() {
  return (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("download-offscreen.html")] })).length > 0;
}

export async function ensureWorker() {
  if (await hasWorker()) return;
  creating ||= chrome.offscreen.createDocument({ url: "download-offscreen.html", reasons: ["WORKERS", "DOM_PARSER", "BLOBS", "LOCAL_STORAGE"],
    justification: "Download video segments, assemble video locally and save it after the popup closes." }).finally(() => { creating = undefined; });
  await creating;
}

async function workerCall(type, payload) {
  const response = await chrome.runtime.sendMessage({ target: "download-offscreen", type, payload });
  if (!response?.ok) throw new Error(response?.error || t("Фоновый загрузчик недоступен"));
  return response.value;
}

async function storedQueue() {
  const key = downloadQueueKey();
  const stored = (await chrome.storage.local.get(key))[key];
  if (stored) return stored;
  const legacy = chrome.extension?.inIncognitoContext ? null : (await chrome.storage.local.get("downloadJob")).downloadJob;
  const queue = { revision: 0, jobs: legacy ? [legacy] : [] };
  await saveQueue(queue);
  return queue;
}
const saveQueue = queue => chrome.storage.local.set({ [downloadQueueKey()]: queue });
const pending = job => activeDownload(job) || ["queued", "permissions"].includes(job.status);
const locked = callback => navigator.locks.request("bookmark-download-job", callback);

async function status() {
  const queue = await storedQueue();
  if (await hasWorker()) {
    const snapshot = await workerCall("status");
    const index = queue.jobs.findIndex(job => job.id === snapshot.job?.id);
    if (index >= 0 && queue.jobs[index].revision < snapshot.job.revision) {
      queue.jobs[index] = snapshot.job;
      queue.revision++;
      await saveQueue(queue);
    }
    await pump(queue);
  } else if (queue.jobs.some(job => activeDownload(job) || job.status === "queued")) {
    queue.jobs = queue.jobs.map(job => activeDownload(job) || job.status === "queued"
      ? { ...job, status: "interrupted", message: t("Загрузка прервана при закрытии браузера или перезапуске расширения."), revision: job.revision + 1 } : job);
    queue.revision++;
    await saveQueue(queue);
  }
  return queue;
}

async function pump(queue) {
  if (queue.jobs.some(activeDownload)) return;
  if (await hasWorker() && (await workerCall("status")).busy) return;
  for (const job of queue.jobs.filter(job => job.status === "queued")) {
    Object.assign(job, { status: "starting", message: t("Запуск фоновой загрузки…"), revision: job.revision + 1 });
    queue.revision++;
    await saveQueue(queue);
    try {
      assertDownloadJob(job);
      await ensureWorker();
      await workerCall("start", job);
      return;
    } catch (error) {
      Object.assign(job, { status: "error", message: t("Не удалось загрузить: $1", [error.message]), revision: job.revision + 1 });
      queue.revision++;
      await saveQueue(queue);
    }
  }
  if (await hasWorker() && !(await workerCall("status")).keepAlive) await chrome.offscreen.closeDocument();
}

function parseRequest(value) {
  if (!value || !Number.isInteger(value.tabId) || value.tabId < 0 || typeof value.url !== "string" || !/^https?:/.test(value.url) || typeof value.title !== "string") throw new Error(t("Некорректная задача загрузки"));
  const source = value.candidate;
  if (!source || !Number.isInteger(source.frameId) || typeof source.frameUrl !== "string" || typeof source.origin !== "string") throw new Error(t("Некорректный источник медиа"));
  const [candidate] = pageMediaCandidates([source], { frameId: source.frameId, frameUrl: source.frameUrl, origin: source.origin });
  if (!candidate?.downloadable) throw new Error(t("Источник недоступен для загрузки"));
  candidate.poster = null;
  if (value.bookmarkId && typeof value.bookmarkId !== "string") throw new Error(t("Некорректная закладка"));
  const size = value.size;
  return { tabId: value.tabId, url: value.url, title: value.title.slice(0, 500), bookmarkId: value.bookmarkId || "", candidate,
    loadedBytes: 0, totalBytes: Number.isSafeInteger(size?.bytes) && size.bytes > 0 ? size.bytes : null, totalApproximate: size?.approximate === true };
}

async function enqueue(request, direct = false) {
  const queue = await status();
  let parsed;
  if (direct) {
    const url = mediaUrl(request?.resourceUrl);
    if (!url || typeof request?.bookmarkId !== "string" || !request.bookmarkId) throw new Error(t("Укажите закладку и прямую ссылку HTTP или HTTPS на файл"));
    const [bookmark] = await chrome.bookmarks.get(request.bookmarkId);
    if (!bookmark?.url) throw new Error(t("Закладка удалена или является папкой"));
    if (!await chrome.permissions.contains({ origins: [hostPattern(url)] })) throw new Error(t("Разрешите доступ к сайту с файлом"));
    parsed = { direct: true, tabId: null, url: bookmark.url, title: bookmark.title || bookmark.url, bookmarkId: bookmark.id,
      candidate: { kind: "file", url, type: "", downloadable: true, transport: "file" }, loadedBytes: 0, totalBytes: null, totalApproximate: false };
  } else {
    parsed = parseRequest(request);
    const tab = await chrome.tabs.get(parsed.tabId);
    if (tab.url !== parsed.url) throw new Error(t("Адрес вкладки изменился. Обновите список ресурсов."));
  }
  assertDownloadJob(parsed);
  const directory = await getResourceDirectory();
  if (!directory || await directory.queryPermission({ mode: "readwrite" }) !== "granted") throw new Error(t("Разрешите доступ к папке ресурсов"));
  if (queue.jobs.some(job => pending(job) && job.tabId === parsed.tabId && job.url === parsed.url && job.candidate.url === parsed.candidate.url
    && (!parsed.bookmarkId || job.bookmarkId === parsed.bookmarkId))) return queue;
  const job = { ...parsed, id: crypto.randomUUID(), createdAt: Date.now(), revision: 1,
    status: "queued", message: t("В очереди"), directoryName: directory.name, origins: [] };
  await setDownloadDirectory(job.id, directory);
  queue.jobs.push(job);
  queue.revision++;
  await saveQueue(queue);
  await pump(queue);
  return queue;
}

export async function handleDownloadMessage(type, payload, offscreen) {
  if (type === "prepare-previews") {
    if (!Array.isArray(payload.resourceIds) || !payload.resourceIds.length || payload.resourceIds.length > 100 || payload.resourceIds.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))) throw new Error(t("Некорректный список видео для превью"));
    const directory = await getResourceDirectory();
    if (!directory) throw new Error(t("Папка ресурсов не выбрана"));
    const id = crypto.randomUUID();
    await setDownloadDirectory(id, directory);
    await ensureWorker();
    return workerCall("prepare-previews", { id, resourceIds: payload.resourceIds });
  }
  if (type === "youtube-preview") return prepareYoutubePreview(payload.id);
  if (type === "status") return locked(status);
  if (type === "clear-finished") return locked(async () => {
    const queue = await storedQueue();
    if (queue.jobs.some(finishedDownload)) {
      queue.jobs = queue.jobs.filter(job => !finishedDownload(job));
      queue.revision++;
      await saveQueue(queue);
    }
    return queue;
  });
  if (type === "start") return locked(() => enqueue(payload));
  if (type === "start-url") return locked(() => enqueue(payload, true));
  if (type === "retry") return locked(async () => {
    const queue = await status();
    const job = queue.jobs.find(job => job.id === payload.id);
    if (!retryableDownload(job)) return queue;
    if (queue.jobs.some(other => other.id !== job.id && pending(other) && other.url === job.url
      && other.candidate.url === job.candidate.url && other.bookmarkId === job.bookmarkId)) {
      throw new Error(t("Это видео уже добавлено в очередь"));
    }
    Object.assign(job, { status: "queued", message: t("В очереди"), loadedBytes: 0, origins: [], revision: job.revision + 1 });
    queue.jobs = [...queue.jobs.filter(other => other.id !== job.id), job];
    queue.revision++;
    await saveQueue(queue);
    await pump(queue);
    return queue;
  });
  if (type === "resume") return locked(async () => {
    const queue = await status();
    const job = queue.jobs.find(job => job.id === payload.id);
    if (job?.status !== "permissions") throw new Error(t("Задача больше не ожидает разрешения"));
    Object.assign(job, { status: "queued", message: t("В очереди"), loadedBytes: 0, origins: [], revision: job.revision + 1 });
    queue.revision++;
    await saveQueue(queue);
    await pump(queue);
    return queue;
  });
  if (type === "cancel") return locked(async () => {
    const queue = await status();
    const job = queue.jobs.find(job => job.id === payload.id);
    if (!job) return queue;
    if (["queued", "permissions"].includes(job.status)) {
      Object.assign(job, { status: "cancelled", message: t("Загрузка отменена."), revision: job.revision + 1 });
      queue.revision++;
      await saveQueue(queue);
      await pump(queue);
    } else if (activeDownload(job) && await hasWorker()) {
      await workerCall("cancel", { id: job.id });
    }
    return queue;
  });
  if (!offscreen) throw new Error(t("Команда доступна только фоновому загрузчику"));
  if (type === "shared-library") return sharedLibraryCall(payload.operation, payload.args, payload.directoryId);
  if (type === "tree") return chrome.bookmarks.getTree();
  if (type === "counts") return chrome.storage.local.set({ resourceCounts: payload.resourceCounts });
  if (type === "permissions") return Promise.all(payload.origins.map(origin => chrome.permissions.contains({ origins: [origin] })));
  if (type === "save") return locked(async () => {
    const queue = await storedQueue();
    const index = queue.jobs.findIndex(job => job.id === payload.job.id);
    if (index < 0 || queue.jobs[index].revision >= payload.job.revision) return;
    queue.jobs[index] = payload.job;
    queue.revision++;
    await saveQueue(queue);
  });
  if (type === "bookmark") {
    if (payload.bookmarkId) {
      const [bookmark] = await chrome.bookmarks.get(payload.bookmarkId);
      if (!bookmark || bookmark.url !== payload.url) throw new Error(t("Закладка удалена или её адрес изменён"));
      return bookmark.id;
    }
    const bookmark = (await chrome.bookmarks.search({ url: payload.url })).find(node => node.url === payload.url)
      || await chrome.bookmarks.create({ title: payload.title || payload.url, url: payload.url });
    return bookmark.id;
  }
  if (type === "blob") {
    const job = (await storedQueue()).jobs.find(job => job.id === payload.id);
    if (job?.id !== payload.id || job.candidate.transport !== "blob" || !Number.isSafeInteger(payload.offset) || payload.offset < 0) throw new Error(t("Некорректный запрос blob"));
    return chrome.scripting.executeScript({ target: { tabId: job.tabId, frameIds: [job.candidate.frameId] }, func: readFrameBlob,
      args: [job.candidate.url, job.candidate.frameUrl, job.id, payload.offset, Boolean(payload.remove), frameBlobMessages()] });
  }
  if (type === "release") return locked(async () => {
    await pump(await storedQueue());
  });
  throw new Error(t("Неизвестная команда загрузчика"));
}

export function registerDownloads() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "download-background") return;
    const offscreen = sender.url === chrome.runtime.getURL("download-offscreen.html");
    const ownPage = ["tab.html", "popup.html", "settings.html"].some(path => sender.url?.split("?")[0] === chrome.runtime.getURL(path));
    if (sender.id !== chrome.runtime.id || !offscreen && !ownPage) { sendResponse({ ok: false, error: t("Недопустимый отправитель") }); return; }
    handleDownloadMessage(message.type, message.payload || {}, offscreen).then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  });
  const recover = () => locked(status).catch(console.warn);
  chrome.runtime.onStartup.addListener(recover);
  chrome.runtime.onInstalled.addListener(recover);
}
