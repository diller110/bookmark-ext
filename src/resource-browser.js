import { t } from "./i18n.js";
import { getResourceDirectory } from "./resource-directory.js";
import { openResourceLibrary } from "./resource-library.js";
import { openBookmarkResources } from "./resources-ui.js";
import { filterResources, resourceMediaKind } from "./model.js";
import { mountBookmarkHover } from "./bookmark-hover.js";
import { formatFileSize } from "./file-size.js";
import { resourceCollectionMenu } from "./collections-ui.js";
import { mountResourceCanvas, readCanvasLayout } from "./resource-canvas.js";
import { canvasLayoutKey } from "./canvas-layout.js";

let cache;
let dispose = () => {};
let closeViewer = () => {};

export function disposeResourceBrowser() {
  document.querySelector("#resource-context-menu")?.hidePopover?.();
  document.querySelector("#resource-selection").hidden = true;
  document.querySelector("main").classList?.remove("resource-canvas-view");
  dispose();
  dispose = () => {};
  closeViewer();
  document.querySelector("#items").className = "";
}

function releaseMedia(container, urls) {
  for (const video of container.querySelectorAll("video")) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  container.replaceChildren();
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}

export function showMedia(resources, selectedId, library) {
  closeViewer();
  const dialog = document.querySelector("#media-dialog");
  const content = document.querySelector("#media-content");
  const previous = document.querySelector("#media-previous");
  const next = document.querySelector("#media-next");
  const setPreview = document.querySelector("#media-set-preview");
  const previewStatus = document.querySelector("#media-preview-status");
  const urls = new Set();
  let index = resources.findIndex(resource => resource.id === selectedId);
  let request = 0;
  const cleanup = () => {
    request++;
    releaseMedia(content, urls);
    document.removeEventListener("keydown", onKeyDown, true);
    previous.onclick = next.onclick = null;
    setPreview.onclick = null;
  };
  closeViewer = () => { cleanup(); if (dialog.open) dialog.close(); };
  dialog.onclose = cleanup;
  const onKeyDown = event => {
    if (!dialog.open) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    navigate(event.key === "ArrowLeft" ? -1 : 1);
  };
  document.addEventListener("keydown", onKeyDown, true);
  previous.onclick = () => navigate(-1);
  next.onclick = () => navigate(1);
  dialog.showModal();
  load();
  function navigate(direction) {
    const target = index + direction;
    if (target < 0 || target >= resources.length) return;
    index = target;
    load();
  }
  async function load() {
    const token = ++request;
    const resource = resources[index];
    setPreview.hidden = true;
    setPreview.disabled = true;
    setPreview.onclick = null;
    previewStatus.textContent = "";
    releaseMedia(content, urls);
    previous.disabled = index === 0;
    next.disabled = index === resources.length - 1;
    document.querySelector("#media-position").textContent = t("$1 из $2", [index + 1, resources.length]);
    document.querySelector("#media-title").textContent = resource.name;
    content.textContent = t("Загрузка…");
    try {
      const file = await library.getFile(resource.id);
      if (token !== request) return;
      const kind = resourceMediaKind(resource.mediaType);
      const url = URL.createObjectURL(file);
      urls.add(url);
      if (!kind) {
        const download = element("a", "settings-button", t("Скачать файл"));
        download.href = url;
        download.download = resource.name;
        const details = element("div", "media-file");
        details.append(element("p", "", t("Для этого файла нет предпросмотра.")), download);
        content.replaceChildren(details);
        return;
      }
      const media = document.createElement(kind);
      if (media.tagName === "VIDEO") {
        media.controls = true; media.preload = "auto"; media.playsInline = true;
        media.autoplay = true; media.muted = true; media.loop = true;
        setPreview.hidden = false;
        let saving = false;
        const update = () => {
          if (token === request) setPreview.disabled = saving || media.readyState < 2 || media.seeking;
        };
        for (const event of ["loadeddata", "seeking", "seeked", "canplay", "error"]) media.addEventListener(event, update);
        setPreview.onclick = async () => {
          if (setPreview.disabled) return;
          saving = true;
          update();
          previewStatus.textContent = t("Сохранение кадра…");
          try {
            const canvas = document.createElement("canvas");
            const scale = Math.min(1, 720 / Math.max(media.videoWidth, media.videoHeight));
            canvas.width = Math.max(1, Math.round(media.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
            canvas.getContext("2d").drawImage(media, 0, 0, canvas.width, canvas.height);
            const image = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.8));
            if (!image) throw new Error(t("Не удалось получить кадр видео"));
            await library.setPreview(resource.id, image);
            document.dispatchEvent(new CustomEvent("resource-preview-changed", { detail: { id: resource.id } }));
            if (token === request) previewStatus.textContent = t("Кадр сохранён как превью");
          } catch (error) {
            if (token === request) previewStatus.textContent = t("Не удалось сохранить превью: $1", [error.message]);
          } finally { saving = false; update(); }
        };
      }
      else media.alt = resource.name;
      media.addEventListener("error", () => {
        if (token === request) content.replaceChildren(element("p", "", t("Не удалось показать файл. Возможно, формат или кодек не поддерживается браузером.")));
      });
      media.src = url;
      content.replaceChildren(media);
    } catch (error) { if (token === request) content.textContent = error.message; }
  }
}

export function previewResourceFiles(items, library, entries) {
  let active = true;
  let loading = 0;
  const queue = [];
  const urls = new Set();
  const thumbnailUrls = new Map();
  const observer = new IntersectionObserver(changes => {
    for (const entry of changes) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      schedule(entry.target);
    }
    loadNext();
  }, { root: document.querySelector("main"), rootMargin: "160px" });
  function schedule(thumbnail) {
    const resource = entries.get(thumbnail);
    if (resourceMediaKind(resource.mediaType) !== "video") { queue.push(thumbnail); return; }
    void library.getPreview(resource.id).catch(() => null).then(poster => {
      if (!active) return;
      if (poster) void loadThumbnail(thumbnail, poster);
      else { queue.push(thumbnail); loadNext(); }
    });
  }
  function loadNext() {
    while (active && loading < 3 && queue.length) {
      loading++;
      void loadThumbnail(queue.shift()).finally(() => { loading--; loadNext(); });
    }
  }
  async function loadThumbnail(thumbnail, cachedPoster) {
      const resource = entries.get(thumbnail);
      try {
        const poster = cachedPoster || (resourceMediaKind(resource.mediaType) === "video" ? await library.getThumbnail(resource.id) : null);
        const file = poster || await library.getFile(resource.id);
        if (!active) return;
        const kind = poster ? "img" : resourceMediaKind(resource.mediaType);
        const oldMedia = thumbnail.querySelector("img, video");
        if (oldMedia?.tagName === "VIDEO") { oldMedia.pause(); oldMedia.removeAttribute("src"); oldMedia.load(); }
        oldMedia?.remove();
        const oldUrl = thumbnailUrls.get(thumbnail);
        if (oldUrl) { URL.revokeObjectURL(oldUrl); urls.delete(oldUrl); }
        const media = document.createElement(kind);
        media.addEventListener("error", () => {
          if (active) { media.remove(); thumbnail.append(element("span", "resource-preview-error", t("Нет превью"))); }
        }, { once: true });
        if (kind === "video") {
          media.muted = true;
          media.playsInline = true;
          media.preload = "metadata";
          media.addEventListener("loadedmetadata", () => {
            if (active) media.currentTime = Number.isFinite(media.duration) ? Math.min(0.1, media.duration / 2) : 0.1;
          }, { once: true });
        } else { media.alt = ""; media.decoding = "async"; }
        const url = URL.createObjectURL(file);
        urls.add(url);
        thumbnailUrls.set(thumbnail, url);
        media.src = url;
        thumbnail.prepend(media);
      } catch { if (active) thumbnail.append(element("span", "resource-preview-error", t("Нет превью"))); }
  }
  for (const thumbnail of entries.keys()) observer.observe(thumbnail);
  const refreshPreview = event => {
    for (const [thumbnail, resource] of entries) {
      if (resource.id === event.detail.id) { observer.unobserve(thumbnail); schedule(thumbnail); }
    }
    loadNext();
  };
  document.addEventListener("resource-preview-changed", refreshPreview);
  return () => { active = false; queue.length = 0; observer.disconnect(); document.removeEventListener("resource-preview-changed", refreshPreview); releaseMedia(items, urls); };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function renderResourceBrowser({ folderId, collectionId, view = "large", tag, query, refresh, isCurrent }) {
  const items = document.querySelector("#items");
  const status = document.querySelector("#status");
  const count = document.querySelector("#resource-mode-count");
  const tagFilter = document.querySelector("#resource-tag-filter");
  status.hidden = false;
  status.textContent = t("Загрузка ресурсов…");
  items.setAttribute("aria-busy", "true");
  try {
    const directory = await getResourceDirectory();
    if (!isCurrent()) return;
    if (!directory) throw new Error(t("Выберите папку ресурсов в настройках, затем вернитесь в режим ресурсов."));
    let resources;
    if (!refresh && cache && cache.folderId === folderId && cache.collectionId === collectionId && await directory.isSameEntry(cache.directory)) {
      resources = cache.resources;
    } else {
      items.replaceChildren();
      count.textContent = "…";
      const library = await openResourceLibrary(directory);
      resources = await library.listResources({ ...(folderId === undefined ? {} : { folderId }), ...(collectionId ? { collectionId } : {}) });
      if (!isCurrent()) return;
      cache = { directory, folderId, collectionId, resources, library };
    }
    if (!isCurrent()) return;
    const library = cache.library;
    let canvasResources, canvasStorageKey, canvasLayout;
    if (view === "canvas") {
      const [libraryId, allResources] = await Promise.all([
        library.getId(),
        folderId !== undefined || collectionId ? library.listResources() : resources
      ]);
      if (!isCurrent()) return;
      canvasResources = allResources;
      canvasStorageKey = canvasLayoutKey(libraryId, folderId, collectionId);
      canvasLayout = await readCanvasLayout(canvasStorageKey);
      if (!isCurrent()) return;
    }
    const availableTags = [...new Set(resources.flatMap(resource => resource.tags))].sort((a, b) => a.localeCompare(b, "ru"));
    if (tag && !availableTags.includes(tag)) availableTags.push(tag);
    const all = element("option", "", t("Все теги"));
    all.value = "";
    tagFilter.replaceChildren(all);
    for (const value of availableTags) {
      const option = element("option", "", value);
      option.value = value;
      tagFilter.append(option);
    }
    tagFilter.value = tag;
    const visible = filterResources(resources, query, tag);
    const mediaResources = visible.filter(resource => resourceMediaKind(resource.mediaType));
    items.replaceChildren();
    items.className = view === "canvas" ? "resource-filmstrip" : "resource-grid-large";
    const main = document.querySelector("main");
    main.classList.toggle("resource-canvas-view", view === "canvas");
    items.setAttribute("aria-label", t("Ресурсы закладок"));
    const previews = new Map();
    const hoverResources = new Map();
    const canvas = view === "canvas" ? mountResourceCanvas(document.querySelector("#resource-canvas"), canvasResources, library, canvasStorageKey, canvasLayout) : null;
    const scrollFilmstrip = event => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || items.scrollWidth <= items.clientWidth) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 17 : event.deltaMode === 2 ? items.clientWidth : 1;
      items.scrollBy({ left: event.deltaY * scale });
    };
    if (canvas) items.addEventListener("wheel", scrollFilmstrip, { passive: false });
    const selected = new Set();
    const selectionRows = new Map();
    const selection = document.querySelector("#resource-selection");
    const selectAll = document.querySelector("#resource-select-all");
    const clearSelection = document.querySelector("#resource-clear-selection");
    let anchor = -1;
    function updateSelection() {
      for (const [id, { checkbox, row }] of selectionRows) {
        checkbox.checked = selected.has(id);
        row.classList.toggle("resource-selected", checkbox.checked);
      }
      selection.hidden = !selected.size;
      document.querySelector("#resource-selected-count").textContent = t("Выбрано: $1", [selected.size]);
    }
    function choose(index, checked, range) {
      const start = range && anchor >= 0 ? Math.min(anchor, index) : index;
      const end = range && anchor >= 0 ? Math.max(anchor, index) : index;
      for (let position = start; position <= end; position++) {
        if (checked) selected.add(visible[position].id);
        else selected.delete(visible[position].id);
      }
      if (!range || anchor < 0) anchor = index;
      updateSelection();
    }
    selectAll.onclick = () => { visible.forEach(resource => selected.add(resource.id)); updateSelection(); };
    clearSelection.onclick = () => { selected.clear(); anchor = -1; updateSelection(); };
    const selectionKeys = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); selectAll.onclick(); }
      else if (event.key === "Escape" && selected.size) { event.preventDefault(); clearSelection.onclick(); }
    };
    items.addEventListener("keydown", selectionKeys);
    for (const [index, resource] of visible.entries()) {
      const li = element("li", "resource-browser-row");
      const checkbox = element("input", "resource-select");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", t("Выбрать ресурс: $1", [resource.name]));
      checkbox.addEventListener("click", event => { event.stopPropagation(); choose(index, checkbox.checked, event.shiftKey); });
      const button = element("button", "resource-card");
      selectionRows.set(resource.id, { checkbox, row: li, button, name: resource.name });
      li.dataset.resourceId = resource.id;
      button.type = "button";
      button.title = `${canvas ? t("Добавить на полотно") : t("Открыть ресурс")}: ${resource.name}`;
      if (canvas) {
        button.draggable = true;
        button.addEventListener("dragstart", event => canvas.startDrag(event, resource.id));
      }
      const icon = element("span", "item-icon resource-file-icon");
      icon.setAttribute("aria-hidden", "true");
      const thumbnail = element("span", "resource-thumbnail");
      thumbnail.append(icon);
      const kind = resourceMediaKind(resource.mediaType);
      if (kind) { previews.set(thumbnail, resource); hoverResources.set(button, resource); }
      if (kind === "video") thumbnail.append(element("span", "resource-video-badge", t("▶ Видео")));
      const copy = element("span", "resource-browser-copy");
      copy.append(element("span", "item-title", resource.name), element("span", "resource-browser-detail", resource.bookmarkTitle || resource.bookmarkUrl));
      if (resource.tags.length) copy.append(element("span", "resource-browser-tags", resource.tags.join(" · ")));
      const size = element("span", "resource-browser-size", formatFileSize(resource.size));
      copy.append(size);
      button.append(thumbnail, copy);
      button.addEventListener("click", event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) { choose(index, event.shiftKey || !selected.has(resource.id), event.shiftKey); return; }
        if (canvas) { canvas.add(resource.id); return; }
        if (kind) showMedia(mediaResources, resource.id, library);
        else openBookmarkResources({ id: resource.bookmarkId, title: resource.bookmarkTitle, url: resource.bookmarkUrl }, resource.id);
      });
      li.addEventListener("contextmenu", event => {
        if (!selected.has(resource.id)) { selected.clear(); choose(index, true, false); }
        resourceCollectionMenu(event, visible.filter(item => selected.has(item.id)), library, collectionId);
      });
      li.append(button, checkbox);
      items.append(li);
    }
    const canvasHost = document.querySelector("#resource-canvas");
    const updateOpened = () => {
      const opened = new Set(canvas.resourceIds);
      for (const [id, { row, button, name }] of selectionRows) {
        const isOpen = opened.has(id);
        row.classList.toggle("resource-on-canvas", isOpen);
        button.title = `${isOpen ? t("На полотне") : t("Добавить на полотно")}: ${name}`;
        if (isOpen) button.setAttribute("aria-description", t("Открыт на полотне"));
        else button.removeAttribute("aria-description");
      }
    };
    if (canvas) { canvasHost.addEventListener("canvas-change", updateOpened); updateOpened(); }
    const releaseFiles = previewResourceFiles(items, library, previews);
    const releaseHover = mountBookmarkHover(items, library, hoverResources, canvas ? 400 : 250);
    dispose = () => {
      canvasHost.removeEventListener("canvas-change", updateOpened);
      releaseHover(); releaseFiles();
      canvas?.dispose();
      items.removeEventListener("wheel", scrollFilmstrip);
      items.removeEventListener("keydown", selectionKeys);
      selectAll.onclick = clearSelection.onclick = null;
    };
    count.textContent = String(visible.length);
    count.title = t("Ресурсов: $1", [visible.length]);
    status.hidden = visible.length > 0;
    status.textContent = query.trim() || tag ? t("Ресурсы по заданным условиям не найдены.") : collectionId
      ? t("В этой подборке пока нет ресурсов. Добавьте их через контекстное меню ресурса.")
      : t("Здесь пока нет ресурсов. В режиме «Закладки» добавьте файлы через кнопку со скрепкой.");
  } catch (error) {
    if (!isCurrent()) return;
    cache = undefined;
    items.replaceChildren();
    count.textContent = "—";
    status.hidden = false;
    status.textContent = error.message;
  } finally {
    if (isCurrent()) items.removeAttribute("aria-busy");
  }
}
