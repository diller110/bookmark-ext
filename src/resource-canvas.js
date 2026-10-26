import { t } from "./i18n.js";
import { createCanvasHistory, canvasDropEdge, canvasResourceIds, splitSizes, resizeCanvasSplit, placeResource, removeResource, restoreCanvasLayout } from "./canvas-layout.js";
import { resourceMediaKind } from "./model.js";

const dragType = "application/x-bookmark-resource";
const histories = new Map();

export async function readCanvasLayout(storageKey) {
  if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(storageKey))[storageKey];
  try { return JSON.parse(localStorage.getItem(storageKey)); }
  catch (error) { console.warn(t("Не удалось восстановить полотно"), error); return null; }
}

export function mountResourceCanvas(host, resources, library, storageKey, savedLayout) {
  const available = new Map(resources.map(resource => [resource.id, resource]));
  const panes = new Map();
  let ids = [];
  let layout = restoreCanvasLayout(savedLayout, available);
  let history = histories.get(storageKey);
  if (!history?.matches(layout)) { history = createCanvasHistory(layout); histories.set(storageKey, history); }
  let finishResize = () => {};
  let active = true;
  let draggedId;
  const hint = document.createElement("p");
  hint.className = "canvas-hint";
  hint.textContent = t("Перетащите ресурс из ленты на полотно или нажмите на его превью. Сбоку — колонка, сверху или снизу — строка, в центре — замена. Ctrl — поменять ресурсы на полотне местами.");
  host.replaceChildren(hint);
  host.hidden = false;

  function save() {
    const failed = error => {
      const status = document.querySelector("#status");
      status.hidden = false;
      status.textContent = t("Не удалось сохранить полотно: $1", [error.message]);
    };
    try {
      if (globalThis.chrome?.storage?.local) void chrome.storage.local.set({ [storageKey]: layout }).catch(failed);
      else localStorage.setItem(storageKey, JSON.stringify(layout));
    } catch (error) { failed(error); }
  }

  function release(entry) {
    entry.active = false;
    const video = entry.node.querySelector("video");
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.node.remove();
  }
  function render() {
    const playing = [...panes.values()].map(pane => pane.node.querySelector("video")).filter(video => video && !video.paused);
    ids = canvasResourceIds(layout);
    host.dataset.count = String(ids.length);
    host.dataset.axis = layout?.axis || "horizontal";
    host.dataset.layout = layout?.axis === "vertical" ? "rows" : "columns";
    hint.hidden = ids.length > 0;
    for (const [id, pane] of panes) if (!ids.includes(id)) { release(pane); panes.delete(id); }
    const renderNode = node => {
      if (typeof node === "string") {
        if (!panes.has(node)) panes.set(node, createPane(available.get(node)));
        return panes.get(node).node;
      }
      const split = document.createElement("div");
      split.className = "canvas-split";
      split.dataset.axis = node.axis;
      const children = node.children.map(renderNode), sizes = splitSizes(node);
      children.forEach((child, index) => {
        child.style.flexGrow = sizes[index];
        if (index) split.append(createResizer(node, children, index - 1));
        split.append(child);
      });
      return split;
    };
    host.replaceChildren(hint, ...(layout ? [renderNode(layout)] : []));
    for (const video of playing) if (video.isConnected) void video.play().catch(() => {});
    host.dispatchEvent(new Event("canvas-change"));
  }
  function createResizer(node, children, index) {
    const horizontal = node.axis === "horizontal";
    const handle = document.createElement("div");
    handle.className = "canvas-resizer";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", horizontal ? t("Ширина колонок") : t("Высота строк"));
    handle.setAttribute("aria-orientation", horizontal ? "vertical" : "horizontal");
    handle.setAttribute("aria-valuemin", "2");
    handle.setAttribute("aria-valuemax", "98");
    const share = () => { const sizes = splitSizes(node); return sizes[index] / (sizes[index] + sizes[index + 1]); };
    const update = ratio => {
      node.sizes = resizeCanvasSplit(node, index, ratio).sizes;
      children.forEach((child, position) => { child.style.flexGrow = node.sizes[position]; });
      handle.parentElement.querySelectorAll(":scope > .canvas-resizer").forEach((boundary, position) => {
        boundary.setAttribute("aria-valuenow", String(Math.round(100 * node.sizes[position] / (node.sizes[position] + node.sizes[position + 1]))));
      });
      save();
    };
    handle.setAttribute("aria-valuenow", String(Math.round(share() * 100)));
    let drag;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const first = children[index].getBoundingClientRect(), second = children[index + 1].getBoundingClientRect();
      drag = { pointerId: event.pointerId, start: horizontal ? event.clientX : event.clientY, first: horizontal ? first.width : first.height,
        total: horizontal ? first.width + second.width : first.height + second.height };
      finishResize = finish;
      handle.setPointerCapture(event.pointerId);
      handle.focus();
      document.body.classList.add(horizontal ? "canvas-resizing-columns" : "canvas-resizing-rows");
    });
    handle.addEventListener("pointermove", event => {
      if (!active || !drag) return;
      const minimum = Math.min(40, drag.total * 0.1);
      const extent = drag.first + (horizontal ? event.clientX : event.clientY) - drag.start;
      update(Math.max(minimum, Math.min(drag.total - minimum, extent)) / drag.total);
    });
    const finish = () => {
      if (!drag) return;
      const { pointerId } = drag;
      drag = null;
      history.record(layout);
      finishResize = () => {};
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.classList.remove("canvas-resizing-columns", "canvas-resizing-rows");
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("lostpointercapture", finish);
    handle.addEventListener("keydown", event => {
      const changes = horizontal ? { ArrowLeft: -0.05, ArrowRight: 0.05 } : { ArrowUp: -0.05, ArrowDown: 0.05 };
      if (!Object.hasOwn(changes, event.key)) return;
      event.preventDefault(); event.stopPropagation();
      finishResize();
      update(share() + changes[event.key]);
      history.record(layout);
    });
    return handle;
  }
  function startDrag(event, id) {
    draggedId = id;
    event.dataTransfer.clearData();
    event.dataTransfer.setData(dragType, id);
    event.dataTransfer.effectAllowed = "copyMove";
  }
  function add(id, targetId, edge = "right") {
    if (!active || !available.has(id)) return;
    layout = placeResource(layout, id, targetId, edge);
    history.record(layout);
    save();
    render();
  }
  function createPane(resource) {
    const node = document.createElement("article");
    node.className = "canvas-pane";
    node.dataset.resourceId = resource.id;
    node.draggable = true;
    node.setAttribute("aria-label", resource.name);
    const media = document.createElement("div");
    media.className = "canvas-media";
    media.textContent = t("Загрузка…");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "canvas-remove";
    close.setAttribute("aria-label", t("Убрать с полотна: $1", [resource.name]));
    close.title = t("Убрать с полотна");
    close.addEventListener("click", () => { layout = removeResource(layout, resource.id); history.record(layout); save(); render(); });
    node.addEventListener("dragstart", event => {
      if (event.target.closest("button, a")) { event.preventDefault(); return; }
      startDrag(event, resource.id);
    });
    const replace = document.createElement("span");
    replace.className = "canvas-replace-indicator";
    replace.textContent = t("Заменить");
    replace.setAttribute("aria-hidden", "true");
    node.append(media, close, replace);
    const entry = { node, active: true, url: null };
    void library.getFile(resource.id).then(file => {
      if (!active || !entry.active) return;
      const kind = resourceMediaKind(resource.mediaType);
      const content = document.createElement(kind || "a");
      entry.url = URL.createObjectURL(file);
      if (kind) {
        content.src = entry.url;
        if (kind === "video") { content.controls = true; content.playsInline = true; content.autoplay = true; content.muted = true; content.loop = true; content.preload = "auto"; }
        else content.alt = resource.name;
        content.addEventListener("error", () => { if (entry.active) media.textContent = t("Превью недоступно"); }, { once: true });
      } else { content.href = entry.url; content.download = resource.name; content.textContent = t("Скачать $1", [resource.name]); }
      media.replaceChildren(content);
    }).catch(error => { if (active && entry.active) media.textContent = error.message; });
    return entry;
  }
  function clearDrop() {
    for (const pane of panes.values()) { delete pane.node.dataset.drop; delete pane.node.dataset.dropLabel; }
    host.classList.remove("canvas-dragging");
  }
  function destination(event) {
    let pane = event.target.closest(".canvas-pane");
    if (!pane && panes.size) {
      const distance = entry => {
        const rect = entry.node.getBoundingClientRect();
        return Math.max(rect.left - event.clientX, 0, event.clientX - rect.right) ** 2 + Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom) ** 2;
      };
      pane = [...panes.values()].sort((a, b) => distance(a) - distance(b))[0].node;
    }
    const rect = (pane || host).getBoundingClientRect();
    let edge = canvasDropEdge(rect, event.clientX, event.clientY);
    if (edge === "replace" && event.ctrlKey && ids.includes(draggedId || event.dataTransfer.getData(dragType))) edge = "swap";
    return { pane, edge };
  }
  const dragover = event => {
    if (!draggedId && !event.dataTransfer.types.includes(dragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDrop();
    const { pane, edge } = destination(event);
    if (pane) {
      pane.dataset.drop = edge;
      pane.dataset.dropLabel = { left: t("Колонка слева"), right: t("Колонка справа"), top: t("Строка сверху"), bottom: t("Строка снизу"), replace: t("Заменить ресурс"), swap: t("Поменять местами") }[edge];
      pane.querySelector(".canvas-replace-indicator").textContent = edge === "swap" ? t("Поменять местами") : t("Заменить");
    }
    else host.classList.add("canvas-dragging");
  };
  const drop = event => {
    const id = draggedId || event.dataTransfer.getData(dragType);
    if (!available.has(id)) return;
    event.preventDefault();
    const { pane, edge } = destination(event);
    clearDrop();
    draggedId = undefined;
    add(id, pane?.dataset.resourceId, edge);
  };
  const leave = event => { if (!host.contains(event.relatedTarget)) clearDrop(); };
  const finishDrag = () => { draggedId = undefined; clearDrop(); };
  const historyKeys = event => {
    if (!active || event.defaultPrevented || !event.ctrlKey || event.altKey || (event.code !== "KeyZ" && event.key.toLowerCase() !== "z")) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']") || document.querySelector("dialog[open]")) return;
    finishResize();
    const restored = event.shiftKey ? history.redo() : history.undo();
    if (restored === undefined) return;
    event.preventDefault();
    clearDrop();
    layout = restored;
    save();
    render();
  };
  host.addEventListener("dragover", dragover);
  host.addEventListener("drop", drop);
  host.addEventListener("dragleave", leave);
  document.addEventListener("dragend", finishDrag);
  document.addEventListener("keydown", historyKeys);
  render();
  return {
    get resourceIds() { return ids; },
    add: id => { if (!ids.includes(id)) add(id, ids.at(-1)); },
    startDrag,
    dispose() {
      finishResize();
      active = false;
      document.body.classList.remove("canvas-resizing-columns", "canvas-resizing-rows");
      host.removeEventListener("dragover", dragover); host.removeEventListener("drop", drop); host.removeEventListener("dragleave", leave);
      document.removeEventListener("dragend", finishDrag);
      document.removeEventListener("keydown", historyKeys);
      for (const pane of panes.values()) release(pane);
      host.replaceChildren(); host.hidden = true;
    }
  };
}
