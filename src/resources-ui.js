import { t } from "./i18n.js";
import { getResourceDirectory } from "./resource-directory.js";
import { openResourceLibrary } from "./resource-library.js";
import { resourceMediaKind } from "./model.js";
import { formatFileSize } from "./file-size.js";
import { mediaUrl } from "./page-media.js";
import { hostPattern } from "./media-scan.js";
import { downloadCall, downloadQueueKey } from "./extension-bridge.js";

const dialog = document.querySelector("#resource-dialog");
const title = document.querySelector("#resource-title");
const status = document.querySelector("#resource-message");
const list = document.querySelector("#resource-list");
const input = document.querySelector("#resource-files");
const upload = document.querySelector("#resource-upload");
const tags = document.querySelector("#bookmark-tags");
const saveTags = document.querySelector("#save-tags");
const grant = document.querySelector("#grant-resource-access");
const preview = document.querySelector("#resource-preview");
const urlInput = document.querySelector("#resource-url");
const urlDownload = document.querySelector("#resource-url-download");
let directory;
let library;
let bookmarkId;
let request = 0;
let lastLinkJob;
const dismissedNotices = new Set();
document.querySelector("#dismiss-library-notice")?.addEventListener("click", () => {
  const notice = document.querySelector("#library-status");
  dismissedNotices.add(notice.textContent);
  notice.textContent = "";
});
const objectUrls = new Set();

function element(tag, text, className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function busy(value) {
  upload.disabled = value;
  saveTags.disabled = value;
  grant.disabled = value;
  tags.disabled = value;
  urlInput.disabled = value;
  urlDownload.disabled = value;
}

function clearPreview() {
  preview.replaceChildren();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

async function currentLibrary(selectedDirectory = directory, selectedLibrary = library) {
  const selected = await getResourceDirectory();
  if (!selected || !await selected.isSameEntry(selectedDirectory)) throw new Error(t("Папка ресурсов изменена в настройках. Закройте и заново откройте ресурсы закладки."));
  return selectedLibrary;
}

async function renderBookmark(keepTags = false) {
  const currentRequest = request;
  const metadata = await library.getBookmark(bookmarkId);
  if (currentRequest !== request) return [];
  if (!keepTags) tags.value = metadata.tags.join(", ");
  list.replaceChildren();
  for (const resource of metadata.resources) {
    const row = element("li", "", "resource-entry");
    row.dataset.resourceId = resource.id;
    const description = element("div", "", "resource-description");
    description.append(element("span", resource.name), element("small", `${resource.mediaType || t("Файл")} · ${formatFileSize(resource.size)}${resource.status === "pending" ? t(" · Загрузка не завершена") : ""}`));
    row.append(description);
    if (resource.status === "ready") {
      const download = element("button", t("Скачать"), "settings-button");
      download.type = "button";
      download.addEventListener("click", async () => {
        const token = request;
        download.disabled = true;
        try {
          const activeLibrary = await currentLibrary();
          if (token !== request) return;
          const file = await activeLibrary.getFile(resource.id);
          if (token !== request) return;
          const url = URL.createObjectURL(file);
          objectUrls.add(url);
          const link = element("a", "");
          link.href = url;
          link.download = resource.name;
          link.click();
        } catch (error) { if (token === request) status.textContent = error.message; }
        finally { download.disabled = false; }
      });
      const kind = resourceMediaKind(resource.mediaType);
      if (kind) {
        const show = element("button", t("Просмотр"), "settings-button");
        show.className += " resource-preview-button";
        show.type = "button";
        show.addEventListener("click", async () => {
          const token = request;
          show.disabled = true;
          try {
            const activeLibrary = await currentLibrary();
            if (token !== request) return;
            const file = await activeLibrary.getFile(resource.id);
            if (token !== request) return;
            clearPreview();
            const url = URL.createObjectURL(file);
            objectUrls.add(url);
            const media = document.createElement(kind);
            if (kind === "video") { media.controls = true; media.playsInline = true; media.autoplay = true; media.muted = true; media.loop = true; media.preload = "auto"; }
            else media.alt = resource.name;
            media.src = url;
            preview.append(media);
          } catch (error) { if (token === request) status.textContent = error.message; }
          finally { show.disabled = false; }
        });
        row.append(show);
      }
      row.append(download);
    }
    list.append(row);
  }
  if (!metadata.resources.length) list.append(element("li", t("У этой закладки пока нет ресурсов."), "resource-empty"));
  return metadata.warnings;
}

export async function openBookmarkResources(bookmark, resourceId) {
  const currentRequest = ++request;
  bookmarkId = bookmark.id;
  title.textContent = bookmark.title || bookmark.url;
  tags.value = "";
  urlInput.value = "";
  lastLinkJob = null;
  list.replaceChildren();
  clearPreview();
  status.textContent = t("Загрузка ресурсов…");
  grant.hidden = true;
  busy(true);
  dialog.showModal();
  try {
    const selected = await getResourceDirectory();
    if (currentRequest !== request) return;
    directory = selected;
    if (!directory) throw new Error(t("Выберите папку ресурсов в настройках."));
    const permitted = await directory.queryPermission({ mode: "readwrite" });
    if (currentRequest !== request) return;
    if (permitted !== "granted") {
      grant.hidden = false;
      grant.disabled = false;
      throw new Error(t("Для добавления ресурсов нужен доступ к чтению и записи выбранной папки."));
    }
    const opened = await openResourceLibrary(directory);
    if (currentRequest !== request) return;
    library = opened;
    const warnings = await renderBookmark();
    if (currentRequest !== request) return;
    status.textContent = warnings.join(". ");
    busy(false);
    if (globalThis.chrome?.runtime?.sendMessage) void downloadCall("status").then(showLinkDownload).catch(console.warn);
    if (resourceId) {
      const row = [...list.children].find(entry => entry.dataset.resourceId === resourceId);
      row?.scrollIntoView({ block: "nearest" });
      row?.querySelector(".resource-preview-button")?.click();
    }
  } catch (error) { if (currentRequest === request) status.textContent = error.message; }
}

grant.addEventListener("click", async () => {
  const token = request;
  const selectedDirectory = directory;
  grant.disabled = true;
  try {
    if (await selectedDirectory.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error(t("Доступ не предоставлен. Разрешите запись, чтобы добавлять ресурсы."));
    if (token !== request) return;
    await currentLibrary(selectedDirectory);
    const opened = await openResourceLibrary(selectedDirectory);
    if (token !== request) return;
    library = opened;
    const warnings = await renderBookmark();
    if (token !== request) return;
    grant.hidden = true;
    status.textContent = warnings.join(". ");
    busy(false);
  } catch (error) { if (token === request) { status.textContent = error.message; grant.disabled = false; } }
});
upload.addEventListener("click", () => input.click());
function showLinkDownload(queue) {
  if (!dialog.open) return;
  const job = queue?.jobs.findLast(job => job.direct && job.bookmarkId === bookmarkId);
  if (!job) return;
  if (lastLinkJob?.id === job.id && lastLinkJob.revision > job.revision) return;
  const completed = job.status === "done" && (lastLinkJob?.id !== job.id || lastLinkJob?.status !== "done");
  lastLinkJob = job;
  status.textContent = ["queued", "starting", "downloading", "saving"].includes(job.status) ? t("$1 Можно закрыть окно.", [job.message]) : job.message;
  if (completed) {
    const token = request;
    void renderBookmark(true).catch(error => { if (token === request) status.textContent = error.message; });
  }
}
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes[downloadQueueKey()]) showLinkDownload(changes[downloadQueueKey()].newValue);
});
document.querySelector("#resource-url-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (urlDownload.disabled) return;
  const url = mediaUrl(urlInput.value.trim());
  if (!url) { status.textContent = t("Укажите прямую ссылку HTTP или HTTPS на файл."); return; }
  const token = request;
  const selectedBookmark = bookmarkId;
  busy(true);
  status.textContent = t("Добавляем загрузку в очередь…");
  try {
    // Request host access while the submit gesture is still active.
    if (!await chrome.permissions.request({ origins: [hostPattern(url)] })) throw new Error(t("Доступ к сайту с файлом не предоставлен"));
    await currentLibrary();
    if (token !== request) return;
    const queue = await downloadCall("start-url", { bookmarkId: selectedBookmark, resourceUrl: url });
    if (token !== request) return;
    urlInput.value = "";
    showLinkDownload(queue);
  } catch (error) { if (token === request) status.textContent = t("Не удалось загрузить: $1", [error.message]); }
  finally { if (token === request) busy(false); }
});
input.addEventListener("change", async () => {
  const token = request;
  const selectedBookmark = bookmarkId;
  const files = [...input.files];
  input.value = "";
  if (!files.length) return;
  busy(true);
  status.textContent = t("Загрузка файлов: $1… Не закрывайте окно до завершения.", [files.length]);
  try {
    const activeLibrary = await currentLibrary();
    if (token !== request) return;
    await activeLibrary.attach(selectedBookmark, files);
    if (token !== request) return;
    status.textContent = t("Загружено файлов: $1", [files.length]);
  } catch (error) { if (token === request) status.textContent = t("Загрузка остановлена: $1. Уже сохранённые файлы останутся в списке.", [error.message]); }
  if (token !== request) return;
  try { await renderBookmark(true); }
  catch (error) { if (token === request) status.textContent = error.message; }
  finally { if (token === request) busy(false); }
});
saveTags.addEventListener("click", async () => {
  const token = request;
  const selectedBookmark = bookmarkId;
  const selectedTags = tags.value.split(",");
  busy(true);
  try {
    const activeLibrary = await currentLibrary();
    if (token !== request) return;
    await activeLibrary.setTags(selectedBookmark, selectedTags);
    if (token !== request) return;
    await renderBookmark();
    if (token !== request) return;
    status.textContent = t("Теги сохранены");
  } catch (error) { if (token === request) status.textContent = error.message; }
  finally { if (token === request) busy(false); }
});
dialog.addEventListener("close", () => { request++; clearPreview(); });

export async function refreshResourceLibrary() {
  const notice = document.querySelector("#library-status");
  const show = message => { notice.textContent = dismissedNotices.has(message) ? "" : message; };
  try {
    const root = await getResourceDirectory();
    if (!root) { notice.textContent = ""; return; }
    const opened = await openResourceLibrary(root);
    const state = await opened.sync();
    const messages = [...state.warnings];
    if (state.pending) messages.push(t("Не завершено сохранение файлов: $1. Проверьте ресурсы закладки и при необходимости добавьте файл заново.", [state.pending]));
    if (state.cleanup) messages.push(t("Остались старые копии или папки: $1. Проверка и очистка повторяются при открытии библиотеки.", [state.cleanup]));
    show(messages.join(" "));
  } catch (error) { show(t("Ресурсы: $1", [error.message])); }
}
