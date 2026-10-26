import { t } from "./i18n.js";
import { indexTree, pathTo } from "./model.js";
import { getResourceDirectory } from "./resource-directory.js";
import { openResourceLibrary } from "./resource-library.js";
import { scanTabMedia, hostPattern } from "./media-scan.js";
import { downloadCall, activeDownload, finishedDownload, retryableDownload, downloadQueueKey } from "./extension-bridge.js";
import { mountVideoPreview } from "./page-preview.js";
import { mediaSize, mediaSizeLabel, downloadSizeLabel } from "./media-size.js";
import { pickedMediaKey } from "./media-picker.js";
import { pageMediaCandidates } from "./page-media.js";
import { openBookmarkResources } from "./resources-ui.js";
import { assertDownloadJob } from "./download-policy.js";

const title = document.querySelector("#tab-title");
const status = document.querySelector("#tab-media-status");
const list = document.querySelector("#tab-media-list");
const choice = document.querySelector("#tab-bookmark");
const rescan = document.querySelector("#tab-rescan");
const pick = document.querySelector("#tab-pick");
const manual = document.querySelector("#tab-manual-upload");
const grant = document.querySelector("#tab-grant-access");
const grantFrames = document.querySelector("#tab-grant-frames");
const downloads = document.querySelector("#download-list");
const clearDownloads = document.querySelector("#download-clear");
let tab;
let bookmarks = [];
let directory;
let permitted = false;
let busy = false;
let scanRequest = 0;
let missingFrames = [];
let queue = { revision: -1, jobs: [] };
let accepting = false;
let previews = [];

function clearPreviews() {
  for (const dispose of previews) dispose();
  previews = [];
}

function element(tag, text, className = "") {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function updateButtons() {
  busy = accepting;
  for (const button of list.querySelectorAll("button[data-available]")) {
    const queued = queue.jobs.find(job => (activeDownload(job) || ["queued", "permissions"].includes(job.status))
      && job.tabId === tab?.id && job.url === tab?.url && job.candidate.url === button.dataset.url
      && (!choice.value || job.bookmarkId === choice.value));
    button.disabled = busy || !permitted || button.dataset.available !== "true" || Boolean(queued);
    button.textContent = queued ? queued.status === "queued" ? t("В очереди") : queued.status === "permissions" ? t("Нужен доступ") : t("Загружается…")
      : bookmarks.length ? t("Загрузить") : t("Добавить закладку и загрузить");
  }
  rescan.disabled = busy;
  pick.disabled = busy;
  grant.disabled = busy;
  grantFrames.disabled = busy;
  choice.disabled = busy;
  manual.disabled = busy || !permitted || !tab;
}

function showQueue(value) {
  if (!value || value.revision <= queue.revision) return;
  const completed = value.jobs.some(job => job.status === "done" && queue.jobs.find(old => old.id === job.id)?.status !== "done");
  queue = value;
  clearDownloads.disabled = !queue.jobs.some(finishedDownload);
  for (const row of [...downloads.children]) {
    if (!queue.jobs.some(job => job.id === row.dataset.id)) row.remove();
  }
  document.querySelector("#download-panel").hidden = !queue.jobs.length;
  const waiting = queue.jobs.filter(job => job.status === "queued").length;
  const active = queue.jobs.some(activeDownload);
  document.querySelector("#download-status").textContent = active ? t("Загружается: 1 · В очереди: $1", [waiting]) : waiting ? t("В очереди: $1", [waiting]) : t("Активных загрузок нет");
  document.querySelector("#download-hint").textContent = active || waiting ? t("Загрузки выполняются по очереди в фоне. Окно можно закрыть.") : "";
  const pending = job => activeDownload(job) || ["queued", "permissions"].includes(job.status);
  const ordered = [...queue.jobs.filter(pending), ...queue.jobs.filter(job => !pending(job))];
  for (const [position, job] of ordered.entries()) {
    let row = [...downloads.children].find(node => node.dataset.id === job.id);
    if (!row) {
      row = element("li", undefined, "download-job");
      row.dataset.id = job.id;
      row.append(element("h3", undefined, "download-title"), element("p", undefined, "download-source"), element("p", undefined, "download-status"), element("p", undefined, "download-size"));
      row.querySelector(".download-status").setAttribute("role", "status");
      const cancel = element("button", t("Отменить загрузку"), "settings-button download-cancel");
      cancel.type = "button";
      cancel.addEventListener("click", async () => {
        try { showQueue(await downloadCall("cancel", { id: job.id })); }
        catch (error) { status.textContent = error.message; }
      });
      const resume = element("button", t("Разрешить доступ и загрузить"), "settings-button download-resume");
      resume.type = "button";
      resume.addEventListener("click", async () => {
        const current = queue.jobs.find(value => value.id === job.id);
        try {
          if (await chrome.permissions.request({ origins: current.origins })) showQueue(await downloadCall("resume", { id: job.id }));
        } catch (error) { status.textContent = error.message; }
      });
      const retry = element("button", t("Повторить"), "settings-button download-retry");
      retry.type = "button";
      retry.addEventListener("click", async () => {
        const current = queue.jobs.find(value => value.id === job.id);
        retry.disabled = true;
        try {
          const candidate = current.candidate;
          const allowed = candidate.url.startsWith("data:") || await chrome.permissions.request({ origins: [hostPattern(candidate.transport === "blob" ? candidate.origin : candidate.url)] });
          if (!allowed) throw new Error(t("Доступ к сайту с медиа не предоставлен"));
          showQueue(await downloadCall("retry", { id: job.id }));
        } catch (error) { status.textContent = t("Не удалось повторить загрузку: $1", [error.message]); }
        finally { retry.disabled = false; }
      });
      row.append(cancel, resume, retry);
    }
    row.querySelector(".download-title").textContent = job.title;
    const url = new URL(job.candidate.url);
    const filename = url.protocol === "data:" ? t("Изображение") : (url.pathname.split("/").pop() || url.host).slice(0, 180);
    row.querySelector(".download-source").textContent = `${job.directoryName} · ${job.candidate.transport.toUpperCase()} · ${filename}`;
    row.querySelector(".download-status").textContent = job.message;
    row.querySelector(".download-size").textContent = downloadSizeLabel(job);
    row.dataset.status = job.status;
    const cancel = row.querySelector(".download-cancel");
    cancel.hidden = !activeDownload(job) && !["queued", "permissions"].includes(job.status);
    cancel.disabled = job.status === "saving";
    row.querySelector(".download-resume").hidden = job.status !== "permissions";
    row.querySelector(".download-retry").hidden = !retryableDownload(job);
    if (downloads.children[position] !== row) downloads.insertBefore(row, downloads.children[position] || null);
  }
  updateButtons();
  if (completed && tab?.url) loadInfo().catch(console.warn);
}

async function loadInfo() {
  const [tree] = await chrome.bookmarks.getTree();
  const nodes = indexTree(tree);
  bookmarks = [...nodes.values()].filter(node => node.url === tab.url);
  const stored = await chrome.storage.local.get("resourceCounts");
  const count = bookmarks.reduce((sum, node) => sum + (stored.resourceCounts?.[node.id] || 0), 0);
  const folder = node => pathTo(nodes, node.parentId).map(parent => parent.title).filter(Boolean).join(" / ") || t("Все папки");
  document.querySelector("#tab-bookmark-info").textContent = bookmarks.length
    ? t("$1 · Ресурсов: $2", [bookmarks.length === 1 ? folder(bookmarks[0]) : t("Закладок: $1", [bookmarks.length]), count])
    : t("Страница ещё не добавлена в закладки.");
  const selected = choice.value;
  choice.replaceChildren();
  for (const bookmark of bookmarks) {
    const option = element("option", `${bookmark.title || tab.title} — ${folder(bookmark)}`);
    option.value = bookmark.id;
    choice.append(option);
  }
  if (bookmarks.some(node => node.id === selected)) choice.value = selected;
  document.querySelector("#tab-bookmark-choice").hidden = bookmarks.length < 2;
  updateButtons();
}

async function loadDirectory() {
  directory = await getResourceDirectory();
  permitted = Boolean(directory && await directory.queryPermission({ mode: "readwrite" }) === "granted");
  const notice = document.querySelector("#tab-directory-status");
  notice.replaceChildren();
  if (permitted) notice.textContent = t("Сохранять в библиотеку «$1».", [directory.name]);
  else if (directory) notice.textContent = t("Для сохранения ресурсов разрешите запись в выбранную папку.");
  else {
    notice.append(t("Для сохранения ресурсов "));
    const link = element("a", t("выберите папку в настройках"));
    link.href = "settings.html?from=tab";
    notice.append(link, ".");
  }
  grant.hidden = !directory || permitted;
  updateButtons();
  if (permitted) {
    try {
      await (await openResourceLibrary(directory)).sync();
      await loadInfo();
    } catch (error) {
      permitted = false;
      notice.textContent = t("Библиотека недоступна: $1", [error.message]);
      updateButtons();
    }
  }
}

async function assertCurrentTab() {
  const current = await chrome.tabs.get(tab.id);
  if (current.url !== tab.url) throw new Error(t("Адрес вкладки изменился. Закройте и заново откройте окно расширения."));
}

async function assertDirectory() {
  const selected = await getResourceDirectory();
  if (!selected || !await selected.isSameEntry(directory)) throw new Error(t("Папка ресурсов изменена. Заново откройте окно расширения."));
}

async function download(candidate) {
  if (busy || !permitted || !candidate.downloadable) return;
  const selectedId = choice.value;
  // Host access must be requested directly from the click gesture.
  const access = candidate.url.startsWith("data:") ? Promise.resolve(true)
    : chrome.permissions.request({ origins: [hostPattern(candidate.transport === "blob" ? candidate.origin : candidate.url)] });
  accepting = true;
  updateButtons();
  status.textContent = t("Запуск фоновой загрузки…");
  try {
    if (!await access) throw new Error(t("Доступ к сайту с медиа не предоставлен"));
    await assertCurrentTab();
    await assertDirectory();
    showQueue(await downloadCall("start", { tabId: tab.id, url: tab.url, title: tab.title || tab.url, bookmarkId: selectedId, candidate, size: candidate.downloadSize }));
    status.textContent = "";
  } catch (error) {
    status.textContent = t("Не удалось загрузить: $1", [error.message]);
  }
  finally { accepting = false; updateButtons(); }
}

async function scan() {
  const token = ++scanRequest;
  clearPreviews();
  list.replaceChildren();
  status.textContent = t("Ищем видео и изображения…");
  try {
    await assertCurrentTab();
    const result = await scanTabMedia(tab);
    if (token !== scanRequest) return;
    const { candidates } = result;
    const stored = (await chrome.storage.local.get(pickedMediaKey(tab.id)))[pickedMediaKey(tab.id)];
    if (token !== scanRequest) return;
    if (stored?.url === tab.url) {
      const selected = stored.candidates.flatMap(item => pageMediaCandidates([item], {
        frameId: item.frameId, frameUrl: item.frameUrl, origin: item.origin
      }).map(candidate => ({ ...candidate, manual: true })));
      for (const candidate of selected.reverse()) {
        const duplicate = candidates.findIndex(item => item.url === candidate.url);
        if (duplicate >= 0) candidates.splice(duplicate, 1);
        candidates.unshift(candidate);
      }
    }
    missingFrames = result.missing;
    grantFrames.hidden = !missingFrames.length;
    document.querySelector("#tab-frame-status").textContent = missingFrames.length ? t("Для поиска видео во встроенных плеерах разрешите доступ к их сайтам.") : "";
    for (const [index, candidate] of candidates.entries()) {
      let downloadRestriction;
      try { assertDownloadJob({ url: tab.url, candidate }); }
      catch (error) { downloadRestriction = error.message; }
      const row = element("li", undefined, "tab-media-card");
      const preview = element("div", undefined, "tab-media-preview");
      const label = candidate.manual ? candidate.kind === "video" ? t("Выбранное видео") : t("Выбранное изображение") : candidate.kind === "video" ? t("Видео $1", [index + 1]) : t("Самое крупное изображение");
      if (candidate.kind === "video" && candidate.downloadable) {
        previews.push(mountVideoPreview(preview, candidate, tab.id, label));
      } else if (candidate.poster || candidate.kind === "image" && candidate.url) {
        const image = element("img");
        image.alt = label;
        image.referrerPolicy = "no-referrer";
        image.src = candidate.poster || candidate.url;
        image.addEventListener("error", () => preview.replaceChildren(element("span", t("Превью недоступно"))), { once: true });
        preview.append(image);
      } else preview.textContent = t("Видео");
      const body = element("div", undefined, "tab-media-card-body");
      body.append(element("h3", label));
      const source = [candidate.transport === "hls" ? "HLS" : candidate.transport === "dash" ? "DASH" : candidate.transport === "blob" ? "Blob" : "",
        candidate.frameId ? `iframe · ${new URL(candidate.origin).host}` : ""].filter(Boolean).join(" · ");
      if (source) body.append(element("p", source));
      if (["hls", "dash"].includes(candidate.transport)) body.append(element("p", new URL(candidate.url).pathname.split("/").pop() || new URL(candidate.url).host));
      if (["hls", "dash", "blob"].includes(candidate.transport)) body.append(element("p", candidate.transport === "blob" ? t("До 512 МБ.") : t("До 512 МБ. Для эфира — доступный фрагмент.")));
      if (candidate.width && candidate.height) body.append(element("p", `${candidate.width} × ${candidate.height}`));
      const size = element("p", t("Размер: уточняется…"), "tab-media-size");
      body.append(size);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      previews.push(() => { clearTimeout(timeout); controller.abort(); });
      void (downloadRestriction ? Promise.resolve(null) : mediaSize(candidate, tab.id, controller.signal)).catch(() => null).then(value => {
        clearTimeout(timeout);
        if (token === scanRequest) {
          candidate.downloadSize = value;
          size.textContent = t("Размер: $1", [mediaSizeLabel(value)]);
        }
      });
      if (!candidate.downloadable) body.append(element("p", t("Источник видео недоступен. Запустите плеер и обновите список.")));
      if (downloadRestriction) body.append(element("p", downloadRestriction));
      const button = element("button", t("Загрузить"), "settings-button");
      button.type = "button";
      button.dataset.available = String(candidate.downloadable && !downloadRestriction);
      button.dataset.url = candidate.url || "";
      button.addEventListener("click", () => download(candidate));
      body.append(button);
      row.append(preview, body);
      list.append(row);
    }
    updateButtons();
    status.textContent = candidates.length ? t("Найдено ресурсов: $1", [candidates.length]) : result.failures.length ? t("Не удалось прочитать часть фреймов. Обновите страницу и повторите поиск.") : t("Видео и изображения на странице не найдены.");
  } catch (error) {
    if (token === scanRequest) status.textContent = t("Не удалось прочитать медиа страницы: $1. На служебных страницах Chrome и некоторых сайтах чтение недоступно.", [error.message]);
  }
}

grant.addEventListener("click", async () => {
  try {
    if (await directory.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error(t("Доступ к папке не предоставлен"));
    await loadDirectory();
  } catch (error) { status.textContent = error.message; }
});
rescan.addEventListener("click", () => scan());
manual.addEventListener("click", async () => {
  accepting = true;
  updateButtons();
  try {
    await assertCurrentTab();
    await assertDirectory();
    const bookmark = bookmarks.find(bookmark => bookmark.id === choice.value)
      || await chrome.bookmarks.create({ title: tab.title || tab.url, url: tab.url });
    await loadInfo();
    await openBookmarkResources(bookmark);
  } catch (error) { status.textContent = t("Не удалось открыть загрузку: $1", [error.message]); }
  finally { accepting = false; updateButtons(); }
});
document.querySelector("#resource-dialog").addEventListener("close", () => {
  loadDirectory().catch(error => { status.textContent = error.message; });
});
pick.addEventListener("click", async () => {
  pick.disabled = true;
  try {
    await assertCurrentTab();
    const result = await chrome.runtime.sendMessage({ type: "start-media-picker", tabId: tab.id });
    if (!result?.ok) throw new Error(result?.error || t("Не удалось включить выбор"));
    status.textContent = t("Выберите ресурс на странице и снова откройте расширение. Esc — отмена.");
    window.close();
  } catch (error) { status.textContent = error.message; }
  finally { updateButtons(); }
});
grantFrames.addEventListener("click", async () => {
  try {
    if (await chrome.permissions.request({ origins: missingFrames })) await scan();
    else status.textContent = t("Доступ к встроенным плеерам не предоставлен.");
  } catch (error) { status.textContent = error.message; }
});
choice.addEventListener("change", updateButtons);
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[downloadQueueKey()]) showQueue(changes[downloadQueueKey()].newValue); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && tab && changes[pickedMediaKey(tab.id)]) void scan(); });
window.addEventListener("pagehide", () => {
  scanRequest++;
  clearPreviews();
});
clearDownloads.addEventListener("click", async () => {
  try { showQueue(await downloadCall("clear-finished")); }
  catch (error) { status.textContent = t("Не удалось очистить очередь: $1", [error.message]); }
});
downloadCall("status").then(showQueue).catch(error => { status.textContent = error.message; });

async function load() {
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error(t("Откройте обычную веб-страницу и нажмите значок расширения"));
    title.textContent = tab.title || t("Без названия");
    document.querySelector("#tab-url").textContent = tab.url;
    await Promise.all([loadInfo(), loadDirectory(), scan()]);
  } catch (error) { title.textContent = t("Текущая вкладка"); status.textContent = error.message; }
}
load();
