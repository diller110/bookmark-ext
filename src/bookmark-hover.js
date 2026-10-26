import { t } from "./i18n.js";
import { resourceMediaKind } from "./model.js";

export function mountBookmarkHover(items, library, resources, delay = 250) {
  const preview = document.createElement("div");
  preview.className = "bookmark-hover-preview";
  preview.setAttribute("popover", "manual");
  preview.setAttribute("aria-hidden", "true");
  document.body.append(preview);
  let target;
  let request = 0;
  let timer;
  let url;
  let bitmap;
  let pressed = false;
  const close = () => {
    request++;
    clearTimeout(timer);
    bitmap?.close();
    bitmap = undefined;
    preview.hidePopover();
    preview.replaceChildren();
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    target = undefined;
  };
  const show = async (thumbnail, resource, token) => {
    const current = () => token === request;
    preview.textContent = t("Загрузка…");
    preview.showPopover();
    const rect = thumbnail.getBoundingClientRect();
    const box = preview.getBoundingClientRect();
    preview.style.left = `${Math.max(8, Math.min(rect.right - box.width, innerWidth - box.width - 8))}px`;
    preview.style.top = `${Math.max(8, rect.bottom + box.height + 8 <= innerHeight ? rect.bottom + 8 : rect.top - box.height - 8)}px`;
    try {
      const kind = resourceMediaKind(resource.mediaType);
      const file = kind === "video" ? await library.getTimelapse(resource.id) : await library.getFile(resource.id);
      if (!current()) return;
      let media;
      if (kind === "video") {
        const decoded = await createImageBitmap(file);
        if (!current()) { decoded.close(); return; }
        bitmap = decoded;
        media = document.createElement("canvas");
        media.className = "resource-timelapse";
        media.width = bitmap.width / 4;
        media.height = bitmap.height / 3;
        const context = media.getContext("2d");
        let frame = 0;
        const draw = () => {
          if (!current()) return;
          context.drawImage(bitmap, frame % 4 * media.width, Math.floor(frame / 4) * media.height, media.width, media.height, 0, 0, media.width, media.height);
          media.dataset.frame = String(frame);
          frame = (frame + 1) % 12;
          timer = setTimeout(draw, 650);
        };
        draw();
      } else {
        media = document.createElement("img");
        media.alt = "";
        media.addEventListener("error", () => { if (current()) preview.textContent = t("Превью недоступно"); }, { once: true });
        url = URL.createObjectURL(file);
        media.src = url;
      }
      const caption = document.createElement("span");
      caption.textContent = resource.name;
      preview.replaceChildren(media, caption);
    } catch { if (current()) preview.textContent = t("Превью недоступно"); }
  };
  const enter = event => {
    if (pressed || event.buttons) return;
    const thumbnail = event.target.closest(".bookmark-resource-thumbnail, .resource-card");
    if (!thumbnail || thumbnail === target || !resources.has(thumbnail)) return;
    close();
    target = thumbnail;
    const token = request;
    timer = setTimeout(() => show(thumbnail, resources.get(thumbnail), token), delay);
  };
  const leave = event => {
    if (target && target.contains(event.target) && !target.contains(event.relatedTarget)) close();
  };
  const escape = event => { if (event.key === "Escape") close(); };
  const press = () => { pressed = true; close(); };
  const release = () => { pressed = false; };
  const blur = () => { release(); close(); };
  items.addEventListener("pointerover", enter);
  items.addEventListener("pointerout", leave);
  items.addEventListener("focusin", enter);
  items.addEventListener("focusout", leave);
  items.addEventListener("click", close, true);
  items.addEventListener("pointerdown", press, true);
  items.addEventListener("dragstart", close, true);
  for (const type of ["pointerup", "pointercancel", "dragend"]) document.addEventListener(type, release, true);
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  window.addEventListener("blur", blur);
  document.addEventListener("keydown", escape);
  return () => {
    close();
    preview.remove();
    items.removeEventListener("pointerover", enter);
    items.removeEventListener("pointerout", leave);
    items.removeEventListener("focusin", enter);
    items.removeEventListener("focusout", leave);
    items.removeEventListener("click", close, true);
    items.removeEventListener("pointerdown", press, true);
    items.removeEventListener("dragstart", close, true);
    for (const type of ["pointerup", "pointercancel", "dragend"]) document.removeEventListener(type, release, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("blur", blur);
    document.removeEventListener("keydown", escape);
  };
}
