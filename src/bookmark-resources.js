import { t } from "./i18n.js";
import { getResourceDirectory } from "./resource-directory.js";
import { openResourceLibrary } from "./resource-library.js";
import { openBookmarkResources } from "./resources-ui.js";
import { previewResourceFiles, showMedia } from "./resource-browser.js";
import { resourceMediaKind } from "./model.js";
import { mountBookmarkHover } from "./bookmark-hover.js";

let dispose = () => {};

export function disposeBookmarkResources() {
  dispose();
  dispose = () => {};
}

export async function renderBookmarkResources(items, rows, isCurrent, onResources) {
  let active = true;
  let release = () => {};
  dispose = () => { active = false; release(); };
  const current = () => active && isCurrent();
  try {
    const directory = await getResourceDirectory();
    if (!current()) return;
    if (!directory) {
      onResources([]);
      for (const { count } of rows.values()) count.textContent = "0";
      return;
    }
    const library = await openResourceLibrary(directory);
    const resources = await library.listResources();
    if (!current()) return;
    onResources(resources);
    if (!rows.size) return;
    const grouped = new Map();
    for (const resource of resources) {
      if (!rows.has(resource.bookmarkId)) continue;
      if (!grouped.has(resource.bookmarkId)) grouped.set(resource.bookmarkId, []);
      grouped.get(resource.bookmarkId).push(resource);
    }
    const previews = new Map();
    for (const [id, { bookmark, count, strip, button }] of rows) {
      const entries = grouped.get(id) || [];
      count.textContent = String(entries.length);
      button.title = t("Ресурсов: $1. Ресурсы и теги закладки", [entries.length]);
      button.setAttribute("aria-label", t("Ресурсы: $1, $2", [bookmark.title || bookmark.url, entries.length]));
      for (const resource of entries.slice(0, 3)) {
        const thumbnail = document.createElement("button");
        thumbnail.type = "button";
        thumbnail.className = "bookmark-resource-thumbnail";
        thumbnail.title = resource.name;
        thumbnail.setAttribute("aria-label", t("Открыть ресурс: $1", [resource.name]));
        const icon = document.createElement("span");
        icon.className = "item-icon resource-file-icon";
        icon.setAttribute("aria-hidden", "true");
        thumbnail.append(icon);
        const kind = resourceMediaKind(resource.mediaType);
        if (kind) previews.set(thumbnail, resource);
        if (kind === "video") {
          const marker = document.createElement("span");
          marker.className = "bookmark-video-marker";
          marker.textContent = "▶";
          marker.setAttribute("aria-hidden", "true");
          thumbnail.append(marker);
        }
        thumbnail.addEventListener("click", () => showMedia(entries, resource.id, library));
        strip.append(thumbnail);
      }
      if (entries.length > 3) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "bookmark-resource-more";
        more.textContent = "…";
        more.title = t("Ещё ресурсов: $1", [entries.length - 3]);
        more.setAttribute("aria-label", t("Все ресурсы закладки: $1", [entries.length]));
        more.addEventListener("click", () => openBookmarkResources(bookmark));
        strip.append(more);
      }
    }
    const releaseFiles = previewResourceFiles(items, library, previews);
    const releaseHover = mountBookmarkHover(items, library, previews);
    release = () => { releaseHover(); releaseFiles(); };
  } catch (error) {
    if (!current()) return;
    onResources(null);
    for (const { count, button } of rows.values()) {
      count.textContent = "—";
      button.title = t("Ресурсы недоступны: $1", [error.message]);
    }
  }
}
