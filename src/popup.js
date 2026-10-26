import { t } from "./i18n.js";
import { indexTree, pathTo, searchBookmarks, safeUrl, filterResources } from "./model.js";
import { openBookmarkResources, refreshResourceLibrary } from "./resources-ui.js";
import { renderResourceBrowser, disposeResourceBrowser } from "./resource-browser.js";
import { renderBookmarkResources, disposeBookmarkResources } from "./bookmark-resources.js";
import { mountCollections } from "./collections-ui.js";

const folders = document.querySelector("#folders");
const items = document.querySelector("#items");
const search = document.querySelector("#search");
const status = document.querySelector("#status");
const retry = document.querySelector("#retry");
const sidebar = document.querySelector("aside");
const main = document.querySelector("main");
const workspace = document.querySelector(".workspace");
const resizer = document.querySelector("#sidebar-resizer");
document.querySelector("#tab-back").hidden = !globalThis.location || new URLSearchParams(location.search).get("from") !== "tab";
let nodes = new Map();
let root;
let selectedId;
let savedView = {};
try {
  const value = JSON.parse(localStorage.getItem("viewState") || "{}");
  if (value && typeof value === "object") savedView = value;
  selectedId = typeof savedView.selectedId === "string" ? savedView.selectedId : localStorage.getItem("lastFolderId");
} catch (error) {
  console.warn(t("Не удалось прочитать состояние окна"), error);
}
let expandedIds = Array.isArray(savedView.expandedIds) ? new Set(savedView.expandedIds.filter(id => typeof id === "string")) : null;
search.value = typeof savedView.query === "string" ? savedView.query : "";
let sidebarWidth = Number.isFinite(savedView.sidebarWidth) ? savedView.sidebarWidth : null;
let mode = savedView.mode === "resources" ? "resources" : "bookmarks";
let resourceView = savedView.resourceView === "canvas" ? "canvas" : "large";
let filmstripCollapsed = savedView.filmstripCollapsed === true;
let headerCollapsed = savedView.headerCollapsed === true;
let sidebarCollapsed = savedView.sidebarCollapsed === true;
let resourceScope = savedView.resourceScope === "folder" ? "folder" : "all";
let resourceTag = typeof savedView.resourceTag === "string" ? savedView.resourceTag : "";
let bookmarkResourceFilter = ["with", "without"].includes(savedView.bookmarkResourceFilter) ? savedView.bookmarkResourceFilter : "all";
let collection = savedView.collection && typeof savedView.collection.id === "string" && typeof savedView.collection.name === "string" ? savedView.collection : null;
let renderRequest = 0;
let bookmarkRendering = Promise.resolve();
const viewScroll = {
  bookmarks: Number.isFinite(savedView.modeScroll?.bookmarks) ? savedView.modeScroll.bookmarks : 0,
  resources: Number.isFinite(savedView.modeScroll?.resources) ? savedView.modeScroll.resources : 0
};
if (Number.isFinite(savedView.mainScrollTop)) viewScroll[mode] = savedView.mainScrollTop;

function resizeSidebar(width) {
  const maximum = Math.max(160, workspace.clientWidth - 246);
  const clamped = Math.round(Math.min(maximum, Math.max(160, width)));
  document.body.style.setProperty("--sidebar-width", `${clamped}px`);
  resizer.setAttribute("aria-valuemin", "160");
  resizer.setAttribute("aria-valuemax", String(maximum));
  resizer.setAttribute("aria-valuenow", String(clamped));
  return clamped;
}

resizeSidebar(sidebarWidth ?? sidebar.getBoundingClientRect().width);
window.addEventListener("resize", () => resizeSidebar(sidebarWidth ?? parseFloat(document.body.style.getPropertyValue("--sidebar-width"))));

let dragOffset = 0;
resizer.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  event.preventDefault();
  dragOffset = event.clientX - sidebar.getBoundingClientRect().right;
  resizer.setPointerCapture(event.pointerId);
  resizer.focus();
  document.body.classList.add("resizing-sidebar");
});
resizer.addEventListener("pointermove", event => {
  if (!resizer.hasPointerCapture(event.pointerId)) return;
  sidebarWidth = resizeSidebar(event.clientX - workspace.getBoundingClientRect().left - dragOffset);
  saveView();
});
resizer.addEventListener("pointerup", event => {
  if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
});
resizer.addEventListener("lostpointercapture", () => document.body.classList.remove("resizing-sidebar"));
resizer.addEventListener("keydown", event => {
  const width = sidebar.getBoundingClientRect().width;
  const widths = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: 160, End: workspace.clientWidth - 246 };
  if (!Object.hasOwn(widths, event.key)) return;
  event.preventDefault();
  sidebarWidth = resizeSidebar(widths[event.key]);
  saveView();
});

function saveView() {
  if (!root) return;
  try {
    viewScroll[mode] = main.scrollTop;
    localStorage.setItem("viewState", JSON.stringify({
      selectedId,
      expandedIds: [...expandedIds],
      sidebarScrollTop: sidebar.scrollTop,
      mainScrollTop: main.scrollTop,
      sidebarWidth: sidebarWidth ?? parseFloat(document.body.style.getPropertyValue("--sidebar-width")),
      query: search.value,
      mode, resourceView, filmstripCollapsed, headerCollapsed, sidebarCollapsed, resourceScope, resourceTag, bookmarkResourceFilter, collection, modeScroll: viewScroll
    }));
  } catch (error) {
    console.warn(t("Не удалось сохранить состояние окна"), error);
  }
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function title(node) {
  return node.id === root.id ? t("Все папки") : node.title || t("Без названия");
}

function selectFolder(id) {
  collection = null;
  selectedId = id;
  if (mode === "resources") resourceScope = id === root.id ? "all" : "folder";
  search.value = "";
  for (const parent of pathTo(nodes, id)) expandedIds.add(parent.id);
  const scrollTop = sidebar.scrollTop;
  folders.replaceChildren(renderFolder(root));
  renderItems();
  sidebar.scrollTop = scrollTop;
  main.scrollTop = 0;
  saveView();
}

function markSelectedFolder() {
  for (const button of folders.querySelectorAll("[data-id]")) {
    if (button.dataset.id === selectedId) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function folderButton(node) {
  const button = element("button", "folder-button");
  button.append(element("span", "folder-label", title(node)));
  button.type = "button";
  button.dataset.id = node.id;
  button.title = title(node);
  button.addEventListener("click", () => selectFolder(node.id));
  return button;
}

function renderFolder(node) {
  const children = (node.children || []).filter(child => !child.url);
  if (!children.length) return folderButton(node);
  const details = element("details");
  details.open = expandedIds.has(node.id);
  const summary = element("summary");
  const toggle = element("button", "toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-label", t("Развернуть или свернуть: $1", [title(node)]));
  toggle.setAttribute("aria-expanded", String(details.open));
  const rememberExpanded = () => {
    if (!details.isConnected) return;
    if (details.open) expandedIds.add(node.id);
    else expandedIds.delete(node.id);
    toggle.setAttribute("aria-expanded", String(details.open));
    saveView();
  };
  toggle.addEventListener("click", event => {
    event.preventDefault();
    details.open = !details.open;
    rememberExpanded();
  });
  details.addEventListener("toggle", rememberExpanded);
  summary.append(toggle, folderButton(node));
  const group = element("div", "folder-children");
  group.append(...children.map(renderFolder));
  details.append(summary, group);
  return details;
}

function renderItems(refresh = false) {
  const token = ++renderRequest;
  if (mode === "resources" && resourceView === "canvas") document.body.classList.add("canvas-focus");
  else document.body.classList.remove("canvas-focus");
  updateCanvasPanels();
  updateFilmstrip();
  disposeBookmarkResources();
  disposeResourceBrowser();
  markSelectedFolder();
  document.querySelector("#bookmarks-mode").setAttribute("aria-pressed", String(mode === "bookmarks"));
  document.querySelector("#resources-mode").setAttribute("aria-pressed", String(mode === "resources"));
  document.querySelector("#resource-filters").hidden = mode !== "resources";
  const bookmarkFilter = document.querySelector("#bookmark-resource-filter");
  bookmarkFilter.hidden = mode !== "bookmarks";
  bookmarkFilter.value = bookmarkResourceFilter;
  bookmarkFilter.disabled = false;
  document.querySelector("#resource-scope").value = resourceScope;
  document.querySelector("#app-title").textContent = mode === "resources" ? t("Ресурсы") : t("Закладки");
  search.placeholder = mode === "resources" ? t("Поиск ресурсов") : t("Поиск закладок");
  search.setAttribute("aria-label", search.placeholder);
  const query = search.value.trim();
  const selected = nodes.get(selectedId);
  const entries = query ? searchBookmarks(nodes, query) : selected.children || [];
  document.querySelector("#bookmarks-mode").textContent = t("Закладки ($1)", [entries.filter(node => node.url).length]);
  const breadcrumbs = document.querySelector("#breadcrumbs");
  breadcrumbs.replaceChildren();
  const pathId = mode === "resources" && resourceScope === "all" ? root.id : selectedId;
  for (const node of pathTo(nodes, pathId)) {
    if (breadcrumbs.childElementCount) breadcrumbs.append(element("span", "", "/"));
    const button = element("button", "", title(node));
    button.type = "button";
    button.addEventListener("click", () => selectFolder(node.id));
    breadcrumbs.append(button);
  }
  if (mode === "resources" && collection) breadcrumbs.append(element("span", "", "/"), element("span", "collection-path", collection.name));
  if (mode === "resources") {
    return renderResourceBrowser({ folderId: resourceScope === "folder" ? selectedId : undefined,
      collectionId: collection?.id, view: resourceView, tag: resourceTag, query, refresh, isCurrent: () => token === renderRequest });
  }
  document.querySelector("#resource-mode-count").textContent = "…";
  items.removeAttribute("aria-busy");
  items.setAttribute("aria-label", query ? t("Результаты поиска") : title(selected));
  items.replaceChildren();
  status.hidden = entries.length > 0;
  status.textContent = query ? t("Ничего не найдено. Попробуйте другое название или адрес.") : t("В этой папке пока нет закладок.");
  const resourceRows = new Map();
  for (const node of entries) {
    const li = element("li");
    if (node.url) { li.className = "bookmark-row"; li.hidden = bookmarkResourceFilter !== "all"; }
    const row = element(node.url ? "a" : "button", "item");
    const icon = element("span", node.url ? "item-icon link-icon" : "item-icon folder-icon");
    icon.setAttribute("aria-hidden", "true");
    const copy = element("span", "item-copy");
    let detail;
    if (node.url) {
      const url = safeUrl(node.url);
      if (url) { row.href = url; row.target = "_blank"; row.rel = "noopener noreferrer"; }
      else { row.setAttribute("aria-disabled", "true"); }
      row.draggable = false;
      row.addEventListener("click", event => {
        const selection = window.getSelection?.();
        if (selection && !selection.isCollapsed && row.contains(selection.anchorNode) && row.contains(selection.focusNode)) event.preventDefault();
      });
      if (url && ["http:", "https:"].includes(new URL(url).protocol)) {
        const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
        faviconUrl.searchParams.set("pageUrl", url);
        faviconUrl.searchParams.set("size", "32");
        const image = element("img", "favicon");
        image.alt = "";
        image.width = 20;
        image.height = 20;
        image.loading = "lazy";
        image.addEventListener("error", () => {
          image.remove();
          icon.className = "item-icon link-icon";
        }, { once: true });
        icon.className = "item-icon favicon-icon";
        icon.append(image);
        image.src = faviconUrl.href;
      }
      detail = query ? pathTo(nodes, node.parentId).map(title).join(" / ") : node.url;
      row.title = url ? `${node.title || node.url}\n${node.url}` : t("Этот тип ссылки не поддерживается");
    } else {
      row.type = "button";
      row.addEventListener("click", () => selectFolder(node.id));
      detail = t("Элементов: $1", [(node.children || []).length]);
    }
    copy.append(element("span", "item-title", node.title || node.url || t("Без названия")), element("span", "item-detail", detail));
    row.append(icon, copy);
    li.append(row);
    if (node.url) {
      const copyTitle = element("button", "expand copy-title-button");
      copyTitle.type = "button";
      const label = t("Копировать название: $1", [node.title || node.url]);
      copyTitle.title = t("Копировать название закладки");
      copyTitle.setAttribute("aria-label", label);
      copyTitle.addEventListener("click", async () => {
        copyTitle.classList.remove("copied");
        try {
          await navigator.clipboard.writeText(node.title || node.url);
          copyTitle.classList.add("copied");
          copyTitle.title = t("Название скопировано");
          copyTitle.setAttribute("aria-label", t("Название скопировано"));
        } catch {
          copyTitle.title = t("Не удалось скопировать. Выделите название и нажмите Ctrl+C.");
          copyTitle.setAttribute("aria-label", copyTitle.title);
        }
        setTimeout(() => {
          copyTitle.classList.remove("copied");
          copyTitle.title = t("Копировать название закладки");
          copyTitle.setAttribute("aria-label", label);
        }, 1800);
      });
      li.append(copyTitle);
      const resources = element("button", "expand resources-button");
      resources.type = "button";
      resources.title = t("Ресурсы и теги закладки");
      resources.setAttribute("aria-label", t("Ресурсы: $1", [node.title || node.url]));
      resources.addEventListener("click", () => openBookmarkResources(node));
      const count = element("span", "bookmark-resource-count", "…");
      resources.append(count);
      const strip = element("span", "bookmark-resource-previews");
      resourceRows.set(node.id, { bookmark: node, count, strip, button: resources, container: li });
      li.append(resources, strip);
    }
    items.append(li);
  }
  bookmarkRendering = renderBookmarkResources(items, resourceRows, () => token === renderRequest, resources => {
    const withResources = new Set(resources?.map(resource => resource.bookmarkId));
    let visibleBookmarks = 0;
    bookmarkFilter.disabled = resources === null;
    for (const [id, { container }] of resourceRows) {
      container.hidden = resources !== null && (bookmarkResourceFilter === "with" && !withResources.has(id)
        || bookmarkResourceFilter === "without" && withResources.has(id));
      if (!container.hidden) visibleBookmarks++;
    }
    document.querySelector("#bookmarks-mode").textContent = t("Закладки ($1)", [visibleBookmarks]);
    if (bookmarkResourceFilter !== "all" && resources !== null) {
      status.hidden = visibleBookmarks > 0;
      status.textContent = query ? t("Нет закладок, соответствующих поиску и фильтру ресурсов.") : t("Нет закладок, соответствующих фильтру ресурсов.");
    }
    const scoped = resources?.filter(resource => resourceScope !== "folder" || pathTo(nodes, resource.bookmarkId).some(node => node.id === selectedId));
    document.querySelector("#resource-mode-count").textContent = scoped ? String(filterResources(scoped, query, resourceTag).length) : "—";
  });
  return bookmarkRendering;
}

async function load() {
  retry.hidden = true;
  try {
    const initialLoad = !root;
    const sidebarScrollTop = initialLoad ? savedView.sidebarScrollTop : sidebar.scrollTop;
    const mainScrollTop = initialLoad ? savedView.mainScrollTop : main.scrollTop;
    [root] = await chrome.bookmarks.getTree();
    nodes = indexTree(root);
    const missingFolder = !nodes.has(selectedId) || nodes.get(selectedId).url;
    if (missingFolder) selectedId = root.id;
    if (expandedIds === null) expandedIds = new Set(pathTo(nodes, selectedId).map(node => node.id));
    expandedIds = new Set([...expandedIds].filter(id => nodes.has(id) && !nodes.get(id).url));
    folders.replaceChildren(renderFolder(root));
    const rendering = renderItems(true);
    const token = renderRequest;
    await rendering;
    if (token !== renderRequest) return;
    sidebar.scrollTop = Number.isFinite(sidebarScrollTop) ? Math.max(0, sidebarScrollTop) : 0;
    main.scrollTop = !missingFolder && Number.isFinite(mainScrollTop) ? Math.max(0, mainScrollTop) : 0;
    search.disabled = false;
    saveView();
    if (mode === "bookmarks") void refreshResourceLibrary();
  } catch (error) {
    status.hidden = false;
    status.textContent = t("Не удалось прочитать закладки. Откройте расширение в Chrome и проверьте разрешение на доступ к закладкам.");
    retry.hidden = false;
    search.disabled = true;
    console.error(error);
  }
}

search.addEventListener("input", () => {
  renderItems();
  main.scrollTop = 0;
  saveView();
});
document.querySelector("#bookmark-resource-filter").addEventListener("change", event => {
  bookmarkResourceFilter = event.target.value;
  renderItems();
  main.scrollTop = 0;
  saveView();
});
sidebar.addEventListener("scroll", saveView, { passive: true });
main.addEventListener("scroll", saveView, { passive: true });
retry.addEventListener("click", load);
async function switchMode(next) {
  if (mode === next || !root) return;
  viewScroll[mode] = main.scrollTop;
  mode = next;
  const rendering = renderItems(next === "resources");
  const token = renderRequest;
  await rendering;
  if (token !== renderRequest) return;
  main.scrollTop = viewScroll[mode];
  saveView();
}
document.querySelector("#bookmarks-mode").addEventListener("click", () => switchMode("bookmarks"));
document.querySelector("#resources-mode").addEventListener("click", () => switchMode("resources"));
function updateCanvasPanels() {
  for (const [panel, collapsed, label] of [
    ["header", headerCollapsed, headerCollapsed ? t("Показать шапку") : t("Свернуть шапку")],
    ["sidebar", sidebarCollapsed, sidebarCollapsed ? t("Показать папки") : t("Свернуть папки")]
  ]) {
    document.body.classList.toggle(`canvas-${panel}-collapsed`, collapsed);
    const button = document.querySelector(`#canvas-${panel}-reveal`);
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", label);
    button.title = label;
  }
}
document.querySelector("#canvas-header-reveal").addEventListener("click", () => {
  headerCollapsed = !headerCollapsed;
  updateCanvasPanels();
  saveView();
});
document.querySelector("#canvas-sidebar-reveal").addEventListener("click", () => {
  sidebarCollapsed = !sidebarCollapsed;
  updateCanvasPanels();
  saveView();
});
function updateFilmstrip() {
  const button = document.querySelector("#resource-filmstrip-toggle");
  button.hidden = mode !== "resources" || resourceView !== "canvas";
  main.classList?.toggle("filmstrip-collapsed", filmstripCollapsed);
  button.setAttribute("aria-expanded", String(!filmstripCollapsed));
  const label = filmstripCollapsed ? t("Показать ленту превью") : t("Свернуть ленту превью");
  button.setAttribute("aria-label", label);
  button.title = label;
}
document.querySelector("#resource-filmstrip-toggle").addEventListener("click", () => {
  filmstripCollapsed = !filmstripCollapsed;
  updateFilmstrip();
  saveView();
});
document.querySelector("#resource-view-menu").addEventListener("click", event => {
  const button = event.target.closest("[data-resource-view]");
  if (!button) return;
  resourceView = button.dataset.resourceView;
  mode = "resources";
  document.querySelector("#resource-view-menu").hidePopover();
  renderItems();
  main.scrollTop = 0;
  saveView();
});
document.querySelector("#resource-view-menu").addEventListener("toggle", event => {
  if (event.newState !== "open") return;
  const menu = event.currentTarget;
  const rect = document.querySelector("#resource-view-toggle").getBoundingClientRect();
  for (const button of menu.querySelectorAll("[data-resource-view]")) button.setAttribute("aria-pressed", String(button.dataset.resourceView === resourceView));
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - menu.offsetHeight - 8))}px`;
});
document.querySelector("#resource-scope").addEventListener("change", event => {
  collection = null;
  resourceScope = event.target.value;
  renderItems();
  main.scrollTop = 0;
  saveView();
});
mountCollections(async selected => {
  if (!root) return;
  collection = selected;
  mode = "resources";
  resourceScope = "all";
  resourceTag = "";
  search.value = "";
  const rendering = renderItems(true);
  main.scrollTop = 0;
  saveView();
  await rendering;
});
window.addEventListener("collections-changed", event => {
  if (!root) return;
  if (collection && collection.id === event.detail?.collection?.id) collection = { ...collection, ...event.detail.collection };
  if (collection && collection.id === event.detail?.deletedId) { collection = null; resourceScope = "all"; }
  saveView();
  if (mode === "resources") void refreshItems();
});
document.querySelector("#resource-tag-filter").addEventListener("change", event => {
  resourceTag = event.target.value;
  renderItems();
  main.scrollTop = 0;
  saveView();
});
async function refreshItems() {
  const scrollTop = main.scrollTop;
  const rendering = renderItems(true);
  const token = renderRequest;
  await rendering;
  if (token !== renderRequest) return;
  main.scrollTop = scrollTop;
  saveView();
}
document.querySelector("#resource-dialog").addEventListener("close", refreshItems);
window.addEventListener("pagehide", () => { disposeBookmarkResources(); disposeResourceBrowser(); });
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !changes.resourceCounts || JSON.stringify(changes.resourceCounts.oldValue) === JSON.stringify(changes.resourceCounts.newValue)) return;
  const rendering = bookmarkRendering;
  void rendering.then(() => {
    if (rendering === bookmarkRendering && mode === "bookmarks" && root && !document.querySelector("#resource-dialog").open) return refreshItems();
  });
});
if (globalThis.chrome?.bookmarks) {
  for (const event of [chrome.bookmarks.onCreated, chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved, chrome.bookmarks.onChildrenReordered, chrome.bookmarks.onImportEnded]) {
    event.addListener(load);
  }
}
load();
