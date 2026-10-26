import { t } from "./i18n.js";
import { getResourceDirectory, setResourceDirectory } from "./resource-directory.js";
import { openResourceLibrary } from "./resource-library.js";
import { sharedLibraryContext } from "./shared-library-client.js";

if (new URLSearchParams(location.search).get("from") === "tab") {
  const back = document.querySelector(".back-link");
  back.href = "tab.html";
  back.title = t("Назад к вкладке");
  back.setAttribute("aria-label", back.title);
}

const choose = document.querySelector("#choose-folder");
const restore = document.querySelector("#restore-access");
const folder = document.querySelector("#resource-folder");
const status = document.querySelector("#folder-status");
let directory;

async function renderDirectory() {
  folder.textContent = directory ? directory.name : t("Папка не выбрана");
  choose.textContent = directory ? t("Изменить папку") : t("Выбрать папку");
  const permitted = directory && await directory.queryPermission({ mode: "readwrite" }) === "granted";
  if (sharedLibraryContext()) {
    choose.disabled = true;
    restore.hidden = true;
    status.textContent = directory ? permitted ? t("Общая библиотека из обычного режима. Чтение и запись разрешены.") : t("Восстановите доступ к папке в обычном окне Chrome.") : t("Выберите папку ресурсов один раз в обычном окне Chrome.");
    return;
  }
  restore.hidden = !directory || permitted;
  status.textContent = directory ? permitted ? t("Папка выбрана. Чтение и запись ресурсов разрешены.") : t("Папка сохранена. Разрешите чтение и запись, чтобы добавлять ресурсы.") : "";
}

choose.addEventListener("click", async () => {
  choose.disabled = true;
  restore.disabled = true;
  try {
    const selected = await window.showDirectoryPicker({
      id: "resource-directory",
      mode: "readwrite",
      ...(directory ? { startIn: directory } : {})
    });
    const selectedLibrary = await openResourceLibrary(selected);
    await selectedLibrary.sync();
    await setResourceDirectory(selected);
    await selectedLibrary.sync().catch(error => console.warn(t("Не удалось обновить счётчик новой библиотеки"), error));
    directory = selected;
    await renderDirectory();
  } catch (error) {
    if (error.name !== "AbortError") {
      status.textContent = t("Не удалось выбрать папку: $1. Предыдущая папка сохранена.", [error.message]);
      console.error(error);
    }
  } finally {
    choose.disabled = false;
    restore.disabled = false;
  }
});

restore.addEventListener("click", async () => {
  choose.disabled = true;
  restore.disabled = true;
  try {
    if (await directory.requestPermission({ mode: "readwrite" }) === "granted") {
      const opened = await openResourceLibrary(directory);
      await opened.sync();
    }
    await renderDirectory();
  } catch (error) {
    status.textContent = t("Не удалось восстановить доступ. Выберите папку заново.");
    console.error(error);
  } finally {
    choose.disabled = false;
    restore.disabled = false;
  }
});

async function load() {
  try {
    directory = await getResourceDirectory();
    await renderDirectory();
  } catch (error) {
    folder.textContent = t("Не удалось загрузить папку");
    status.textContent = t("Не удалось прочитать настройки. Можно выбрать папку заново.");
    console.error(error);
  }
  if (typeof window.showDirectoryPicker !== "function") {
    status.textContent = t("Выбор папки недоступен. Откройте настройки в отдельной вкладке Chrome.");
  } else if (!sharedLibraryContext()) {
    choose.disabled = false;
  }
}

load();
