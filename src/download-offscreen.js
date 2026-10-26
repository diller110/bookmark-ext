import { t } from "./i18n.js";
import { downloadCall } from "./extension-bridge.js";
import { getResourceDirectory, getDownloadDirectory } from "./resource-directory.js";
import { openResourceLibrary } from "./resource-library.js";
import { fetchPageMedia } from "./page-media.js";
import { downloadFrameBlob } from "./media-scan.js";
import { downloadStream, MediaPermissionsRequired } from "./stream-download.js";
import { registerSharedLibrary, sharedLibraryBusy, sharedLibraryUsed } from "./shared-library-server.js";
import { enqueuePreviews, previewsPending } from "./preview-queue.js";
import { assertDownloadJob } from "./download-policy.js";

registerSharedLibrary();

let job;
let controller;
let publishing = Promise.resolve();

function publish(patch) {
  job = { ...job, ...patch, revision: job.revision + 1 };
  const snapshot = job;
  publishing = publishing.catch(() => {}).then(() => downloadCall("save", { job: snapshot }));
  return publishing;
}

async function run() {
  const signal = controller.signal;
  try {
    assertDownloadJob(job);
    await publish({ status: "downloading", message: t("Загрузка в фоне…") });
    const selected = await getDownloadDirectory(job.id);
    if (selected?.id !== job.id) throw new Error(t("Папка задачи недоступна"));
    const directory = selected.directory;
    const assertDirectory = async () => {
      const current = await getResourceDirectory();
      if (!current || !await current.isSameEntry(directory)) throw new Error(t("Папка ресурсов изменена. Начните загрузку заново."));
    };
    await assertDirectory();
    const library = await openResourceLibrary(directory);
    let lastProgress = 0;
    const options = { signal, onProgress: (message, bytes = {}) => {
      job = { ...job, ...bytes };
      if (signal.aborted || Date.now() - lastProgress < 200) return;
      lastProgress = Date.now(); publish({ message, ...bytes }).catch(console.warn);
    }, readChunk: (offset, remove = false) => downloadCall("blob", { id: job.id, offset, remove }) };
    const file = job.candidate.transport === "blob" ? await downloadFrameBlob(job.tabId, job.candidate, options)
      : ["hls", "dash"].includes(job.candidate.transport) ? await downloadStream(job.candidate, options) : await fetchPageMedia(job.candidate, options);
    signal.throwIfAborted();
    await assertDirectory();
    signal.throwIfAborted();
    await publish({ status: "saving", message: t("Сохранение в библиотеку…"), loadedBytes: file.size, totalBytes: file.size, totalApproximate: false });
    const bookmarkId = await downloadCall("bookmark", { bookmarkId: job.bookmarkId, url: job.url, title: job.title });
    await publish({ bookmarkId });
    await library.attach(bookmarkId, [file]);
    await publish({ status: "done", message: t("Сохранено: $1", [file.name]), name: file.name });
  } catch (error) {
    if (error instanceof MediaPermissionsRequired) await publish({ status: "permissions", message: t("Нужен доступ к дополнительным доменам потока."), origins: error.origins });
    else await publish({ status: signal.aborted ? "cancelled" : "error", message: signal.aborted ? t("Загрузка отменена.") : t("Не удалось загрузить: $1", [error.message]) });
  } finally {
    controller = undefined;
    await downloadCall("release", { id: job.id }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "download-offscreen" || sender.id !== chrome.runtime.id || sender.tab || sender.url && sender.url !== chrome.runtime.getURL("src/background.js")) return;
  if (message.type === "prepare-previews") {
    enqueuePreviews(message.payload);
    sendResponse({ ok: true, value: null });
    return;
  }
  if (message.type === "status") { sendResponse({ ok: true, value: { job: job || null, busy: Boolean(controller) || sharedLibraryBusy > 0, keepAlive: sharedLibraryUsed || previewsPending() } }); return; }
  if (message.type === "start") {
    if (controller) { sendResponse({ ok: false, error: t("Загрузчик уже занят") }); return; }
    job = message.payload; controller = new AbortController();
    sendResponse({ ok: true, value: job });
    run().catch(console.error);
  } else if (message.type === "cancel") {
    if (job?.id === message.payload.id && job.status !== "saving") controller?.abort();
    sendResponse({ ok: true, value: job });
  }
});
