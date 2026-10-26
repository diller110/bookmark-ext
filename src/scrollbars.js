import { t } from "./i18n.js";
const entries = new Map();
const layer = document.createElement("div");
layer.className = "overlay-scrollbars";
layer.setAttribute("popover", "manual");
document.body.append(layer);
layer.showPopover();
let frame;
let scanNeeded = true;
let movingUntil = 0;
let drag;
let sequence = 0;
const candidates = "html,body,main,aside,dialog,section,nav,div,ul,ol,p,h1,h2,textarea";

function schedule(scan = false) {
  scanNeeded ||= scan;
  frame ||= requestAnimationFrame(update);
}

const resize = new ResizeObserver(() => schedule(true));
resize.observe(document.documentElement);

function activate(entry) {
  entry.until = performance.now() + 900;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => schedule(), 920);
  schedule();
}

function ensure(node) {
  if (entries.has(node)) return entries.get(node);
  if (layer.contains(node)) return null;
  const style = getComputedStyle(node);
  const root = node === document.scrollingElement;
  if (!root && !/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) return null;
  const entry = { node, bars: [], hover: false, until: 0 };
  entries.set(node, entry);
  resize.observe(node);
  return entry;
}

// Chrome's RTL scrollLeft is negative; overlay coordinates run from the physical left edge.
function horizontalOrigin(node) {
  return getComputedStyle(node).direction === "rtl" ? node.scrollWidth - node.clientWidth : 0;
}

function makeBar(entry, vertical) {
  const track = document.createElement("div");
  track.className = "overlay-scrollbar";
  track.tabIndex = 0;
  track.setAttribute("role", "scrollbar");
  track.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
  track.setAttribute("aria-label", vertical ? t("Прокрутка по вертикали") : t("Прокрутка по горизонтали"));
  if (!entry.node.id) entry.node.id = `overlay-scroll-target-${++sequence}`;
  track.setAttribute("aria-controls", entry.node.id);
  const thumb = document.createElement("div");
  thumb.className = "overlay-scrollbar-thumb";
  track.append(thumb);
  layer.append(track);
  const bar = { track, thumb, vertical, metrics: null };
  const setOffset = offset => { entry.node[vertical ? "scrollTop" : "scrollLeft"] = offset - (vertical ? 0 : horizontalOrigin(entry.node)); activate(entry); };
  track.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !bar.metrics || bar.metrics.length <= bar.metrics.size) return;
    event.preventDefault();
    const rect = track.getBoundingClientRect();
    const position = vertical ? event.clientY - rect.top : event.clientX - rect.left;
    const { offset, maximum, length, size } = bar.metrics;
    const thumbStart = offset / maximum * (length - size);
    drag = { bar, entry, grab: event.target === thumb ? position - thumbStart : size / 2 };
    track.setPointerCapture(event.pointerId);
    if (event.target !== thumb) setOffset((position - drag.grab) / (length - size) * maximum);
    schedule();
  });
  track.addEventListener("pointermove", event => {
    if (drag?.bar !== bar || !bar.metrics) return;
    const rect = track.getBoundingClientRect();
    const position = vertical ? event.clientY - rect.top : event.clientX - rect.left;
    const { maximum, length, size } = bar.metrics;
    setOffset((position - drag.grab) / (length - size) * maximum);
  });
  const finish = () => { if (drag?.bar === bar) { drag = null; activate(entry); } };
  track.addEventListener("pointerup", finish);
  track.addEventListener("lostpointercapture", finish);
  track.addEventListener("wheel", event => {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 17 : event.deltaMode === 2 ? entry.node.clientHeight : 1;
    entry.node.scrollBy({ top: vertical ? event.deltaY * scale : 0, left: (event.deltaX || (!vertical ? event.deltaY : 0)) * scale });
    activate(entry);
  }, { passive: false });
  track.addEventListener("keydown", event => {
    const offset = entry.node[vertical ? "scrollTop" : "scrollLeft"] + (vertical ? 0 : horizontalOrigin(entry.node));
    const page = entry.node[vertical ? "clientHeight" : "clientWidth"];
    const values = { Home: 0, End: bar.metrics?.maximum, PageUp: offset - page, PageDown: offset + page,
      [vertical ? "ArrowUp" : "ArrowLeft"]: offset - 40, [vertical ? "ArrowDown" : "ArrowRight"]: offset + 40 };
    if (!Object.hasOwn(values, event.key) || values[event.key] === undefined) return;
    event.preventDefault();
    setOffset(values[event.key]);
  });
  return bar;
}

function bounds(node) {
  const root = node === document.scrollingElement;
  const rect = root ? { left: 0, top: 0 } : node.getBoundingClientRect();
  const left = root ? 0 : rect.left + node.clientLeft;
  const top = root ? 0 : rect.top + node.clientTop;
  let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  if (!root) for (let parent = node.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const box = parent.getBoundingClientRect();
    if (style.overflowX !== "visible") { clip.left = Math.max(clip.left, box.left); clip.right = Math.min(clip.right, box.right); }
    if (style.overflowY !== "visible") { clip.top = Math.max(clip.top, box.top); clip.bottom = Math.min(clip.bottom, box.bottom); }
  }
  return { left, top, width: root ? innerWidth : node.clientWidth, height: root ? innerHeight : node.clientHeight, clip };
}

function update() {
  frame = 0;
  if (scanNeeded) {
    scanNeeded = false;
    for (const node of document.querySelectorAll(candidates)) ensure(node);
  }
  for (const [node, entry] of entries) {
    if (!node.isConnected) {
      clearTimeout(entry.timer); resize.unobserve(node);
      entry.bars.forEach(bar => bar.track.remove()); entries.delete(node); continue;
    }
    const box = bounds(node);
    const style = getComputedStyle(node);
    const root = node === document.scrollingElement;
    const vertical = (root || /(auto|scroll)/.test(style.overflowY)) && node.scrollHeight > node.clientHeight + 1;
    const horizontal = (root || /(auto|scroll)/.test(style.overflowX)) && node.scrollWidth > node.clientWidth + 1;
    for (const isVertical of [true, false]) {
      const index = isVertical ? 0 : 1;
      let bar = entry.bars[index];
      const needed = isVertical ? vertical : horizontal;
      if (!needed) { if (bar) bar.track.hidden = true; continue; }
      if (!bar) entry.bars[index] = bar = makeBar(entry, isVertical);
      let left = isVertical ? box.left + box.width - 6 : box.left;
      let top = isVertical ? box.top : box.top + box.height - 6;
      let width = isVertical ? 6 : box.width - (vertical ? 6 : 0);
      let height = isVertical ? box.height - (horizontal ? 6 : 0) : 6;
      const right = Math.min(left + width, box.clip.right), bottom = Math.min(top + height, box.clip.bottom);
      left = Math.max(left, box.clip.left); top = Math.max(top, box.clip.top);
      width = right - left; height = bottom - top;
      bar.track.hidden = width <= 0 || height <= 0 || !node.getClientRects().length;
      if (bar.track.hidden) continue;
      const length = isVertical ? height : width;
      const client = isVertical ? node.clientHeight : node.clientWidth;
      const total = isVertical ? node.scrollHeight : node.scrollWidth;
      const maximum = total - client;
      const offset = isVertical ? node.scrollTop : node.scrollLeft + horizontalOrigin(node);
      const size = Math.min(length, Math.max(24, length * client / total));
      bar.metrics = { length, maximum, offset, size };
      Object.assign(bar.track.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      Object.assign(bar.thumb.style, { width: `${isVertical ? width : size}px`, height: `${isVertical ? size : height}px`,
        transform: `translate${isVertical ? "Y" : "X"}(${Math.max(0, offset / maximum * (length - size))}px)` });
      bar.track.setAttribute("aria-valuemin", "0"); bar.track.setAttribute("aria-valuemax", String(maximum)); bar.track.setAttribute("aria-valuenow", String(Math.round(offset)));
      bar.track.classList.toggle("is-visible", entry.hover || entry.until > performance.now() || drag?.entry === entry);
    }
  }
  if (performance.now() < movingUntil) schedule();
}

document.addEventListener("scroll", event => {
  const node = event.target === document ? document.scrollingElement : event.target;
  if (!(node instanceof Element) || layer.contains(node)) return;
  const entry = ensure(node);
  if (entry) activate(entry);
}, { capture: true, passive: true });

document.addEventListener("pointermove", event => {
  for (const entry of entries.values()) entry.hover = entry.node.contains(event.target) || entry.bars.some(bar => bar.track.contains(event.target));
  schedule();
}, { passive: true });
document.addEventListener("pointerout", event => {
  if (event.relatedTarget) return;
  for (const entry of entries.values()) entry.hover = false;
  schedule();
});
document.addEventListener("transitionrun", event => {
  if (event.propertyName !== "transform") return;
  movingUntil = performance.now() + 300; schedule();
});
document.addEventListener("toggle", event => {
  if (event.target === layer) return;
  const parent = document.querySelector("dialog:modal") || document.body;
  if (layer.parentElement !== parent) parent.append(layer);
  if (event.newState === "open" || !layer.matches(":popover-open")) { layer.hidePopover(); layer.showPopover(); }
  schedule(true);
}, true);
new MutationObserver(records => {
  if (records.some(record => !layer.contains(record.target))) schedule(true);
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
window.addEventListener("resize", () => schedule(true));
window.addEventListener("pageshow", () => schedule(true));
window.addEventListener("pagehide", () => { cancelAnimationFrame(frame); frame = 0; for (const entry of entries.values()) clearTimeout(entry.timer); });
schedule(true);
