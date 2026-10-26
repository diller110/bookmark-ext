import { t } from "./i18n.js";
export function popupSize(value) {
  const limit = (number, fallback, minimum, maximum) => Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.round(number))) : fallback;
  return { width: limit(value?.width, 780, 480, 800), height: limit(value?.height, 580, 360, 600) };
}

if (globalThis.chrome?.extension?.getViews({ type: "popup" }).includes(globalThis.window)) {
  const body = document.body;
  document.documentElement.classList.add("extension-popup");
  let size;
  try { size = popupSize(JSON.parse(localStorage.getItem("popupSize") || "null")); }
  catch { size = popupSize(); }
  const bar = document.createElement("footer");
  bar.className = "popup-size-bar";
  const label = document.createElement("span");
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "popup-size-handle";
  handle.setAttribute("aria-label", t("Изменить размер окна"));
  handle.title = t("Потяните за угол, чтобы изменить размер. Стрелки на клавиатуре — шаг 20 пикселей.");
  bar.append(label, handle);
  body.append(bar);

  const apply = value => {
    size = popupSize(value);
    body.style.width = `${size.width}px`;
    body.style.height = `${size.height}px`;
    label.textContent = `${size.width} × ${size.height}`;
  };
  const save = () => {
    try { localStorage.setItem("popupSize", JSON.stringify(size)); }
    catch (error) { console.warn(t("Не удалось сохранить размер окна"), error); }
  };
  apply(size);
  let drag;
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    drag = { ...size, x: event.screenX, y: event.screenY, id: event.pointerId };
    handle.setPointerCapture(event.pointerId);
    body.classList.add("resizing-popup");
    event.preventDefault();
  });
  handle.addEventListener("pointermove", event => {
    if (drag?.id !== event.pointerId) return;
    apply({ width: drag.width + event.screenX - drag.x, height: drag.height + event.screenY - drag.y });
  });
  const finish = () => {
    if (!drag) return;
    drag = undefined;
    body.classList.remove("resizing-popup");
    save();
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("lostpointercapture", finish);
  window.addEventListener("pagehide", finish);
  handle.addEventListener("keydown", event => {
    const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (!delta) return;
    event.preventDefault();
    apply({ width: size.width + delta[0], height: size.height + delta[1] });
    save();
  });
}
