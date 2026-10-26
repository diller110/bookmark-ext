import { t } from "./i18n.js";
import { getResourceDirectory } from "./resource-directory.js";
import { openResourceLibrary } from "./resource-library.js";

function button(text, action) {
  const node = document.createElement("button");
  node.type = "button";
  node.setAttribute("role", "menuitem");
  node.textContent = text;
  node.addEventListener("click", action);
  return node;
}

function position(menu, x, y) {
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
}

function message(menu, text) {
  const node = document.createElement("p");
  node.textContent = text;
  node.setAttribute("role", "status");
  menu.replaceChildren(node);
}

async function currentLibrary() {
  const directory = await getResourceDirectory();
  if (!directory) throw new Error(t("Выберите папку ресурсов в настройках"));
  return openResourceLibrary(directory);
}

let toastTimer;
function toast(text) {
  const chip = document.querySelector("#collection-toast");
  clearTimeout(toastTimer);
  chip.textContent = text;
  chip.showPopover();
  toastTimer = setTimeout(() => chip.hidePopover(), 3500);
}

function editCollection(library, saved, collection = null) {
  const dialog = document.querySelector("#collection-dialog");
  const input = document.querySelector("#collection-name");
  const error = document.querySelector("#collection-error");
  const save = document.querySelector("#collection-save");
  input.value = collection?.name || "";
  document.querySelector("#collection-title").textContent = collection ? t("Переименовать подборку") : t("Новая подборка");
  save.textContent = collection ? t("Сохранить") : t("Создать");
  error.textContent = "";
  save.disabled = false;
  document.querySelector("#collection-cancel").onclick = () => dialog.close();
  document.querySelector("#collection-form").onsubmit = async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try {
      const result = collection ? await library.renameCollection(collection.id, input.value) : await library.createCollection(input.value);
      dialog.close();
      await saved(result);
    } catch (reason) {
      if (dialog.open) error.textContent = reason.message;
      else document.querySelector("#library-status").textContent = reason.message;
    } finally { save.disabled = false; }
  };
  dialog.showModal();
  input.focus();
}

export function mountCollections(select) {
  const menu = document.querySelector("#collections-menu");
  const toggle = document.querySelector("#collections-toggle");
  for (const popup of [menu, document.querySelector("#resource-context-menu")]) {
    popup.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...popup.querySelectorAll("button:not(:disabled)")];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    });
  }
  let request = 0;
  menu.addEventListener("toggle", async event => {
    const token = ++request;
    if (event.newState !== "open") return;
    message(menu, t("Загрузка подборок…"));
    const anchor = toggle.getBoundingClientRect();
    position(menu, anchor.left, anchor.bottom + 6);
    try {
      const library = await currentLibrary();
      const collections = await library.listCollections();
      if (token !== request || !menu.matches(":popover-open")) return;
      menu.replaceChildren();
      if (!collections.length) message(menu, t("Подборок пока нет"));
      for (const collection of collections) {
        const row = document.createElement("div");
        row.className = "collection-menu-row";
        const actions = button("⋮", () => {
          menu.replaceChildren(button(t("Переименовать"), () => {
            menu.hidePopover();
            editCollection(library, renamed => {
              window.dispatchEvent(new CustomEvent("collections-changed", { detail: { collection: renamed } }));
              toast(t("Подборка переименована в «$1»", [renamed.name]));
            }, collection);
          }), button(t("Удалить подборку"), async () => {
            try {
              await library.deleteCollection(collection.id);
              menu.hidePopover();
              window.dispatchEvent(new CustomEvent("collections-changed", { detail: { deletedId: collection.id } }));
              toast(t("Подборка «$1» удалена", [collection.name]));
            } catch (error) { message(menu, error.message); }
          }));
          menu.querySelector("button")?.focus();
          position(menu, anchor.left, anchor.bottom + 6);
        });
        actions.setAttribute("aria-label", t("Действия с подборкой «$1»", [collection.name]));
        row.append(button(`${collection.name} (${collection.count})`, () => { menu.hidePopover(); select(collection); }), actions);
        menu.append(row);
      }
      const add = button(t("+ Добавить новую подборку"), () => {
        menu.hidePopover();
        editCollection(library, select);
      });
      add.className = "collection-create";
      menu.append(add);
      position(menu, anchor.left, anchor.bottom + 6);
    } catch (error) { if (token === request) message(menu, error.message); }
  });
}

export function resourceCollectionMenu(event, resources, library, collectionId) {
  event.preventDefault();
  const menu = document.querySelector("#resource-context-menu");
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX || rect.left;
  const y = event.clientY || rect.bottom;
  const ids = resources.map(resource => resource.id);
  const added = collection => {
    toast(ids.length === 1 ? t("Добавлено в подборку «$1»", [collection.name]) : t("Добавлено в подборку «$1»: $2", [collection.name, ids.length]));
    window.dispatchEvent(new CustomEvent("collections-changed"));
  };
  const add = async collection => {
    try { await library.addToCollection(collection.id, ids); menu.hidePopover(); added(collection); }
    catch (error) { message(menu, error.message); }
  };
  menu.replaceChildren(button(ids.length === 1 ? t("Добавить в подборку…") : t("Добавить выбранные в подборку… ($1)", [ids.length]), async () => {
    message(menu, t("Загрузка подборок…"));
    try {
      const collections = await library.listCollections();
      if (!menu.matches(":popover-open")) return;
      menu.replaceChildren();
      if (!collections.length) message(menu, t("Подборок пока нет"));
      for (const collection of collections) menu.append(button(collection.name, () => add(collection)));
      const create = button(t("+ Добавить новую подборку"), () => {
        menu.hidePopover();
        editCollection(library, async collection => { await library.addToCollection(collection.id, ids); added(collection); });
      });
      create.className = "collection-create";
      menu.append(create);
      position(menu, x, y);
      menu.querySelector("button")?.focus();
    } catch (error) { message(menu, error.message); }
  }));
  if (collectionId) menu.append(button(ids.length === 1 ? t("Убрать из подборки") : t("Убрать выбранные из подборки ($1)", [ids.length]), async () => {
    try {
      await library.removeFromCollection(collectionId, ids);
      menu.hidePopover();
      window.dispatchEvent(new CustomEvent("collections-changed"));
      toast(ids.length === 1 ? t("Ресурс убран из подборки") : t("Убрано из подборки: $1", [ids.length]));
    } catch (error) { message(menu, error.message); }
  }));
  menu.showPopover();
  position(menu, x, y);
  menu.querySelector("button").focus();
}
