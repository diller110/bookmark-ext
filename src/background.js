import { t } from "./i18n.js";
import { toolbarIcon } from "./toolbar-icon.js";
import { registerDownloads } from "./download-manager.js";
import { registerSharedLibraryBridge } from "./shared-library-background.js";
import { registerMediaPicker } from "./media-picker.js";

if (chrome.storage.local.setAccessLevel) {
  void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(console.warn);
}

if (chrome.runtime.onMessage) { registerDownloads(); registerMediaPicker(); }
if (chrome.extension) registerSharedLibraryBridge();

const requests = new Map();
let sequence = 0;

function setTabIcon(details) {
  // Chrome's setIcon binding can resolve its Promise without consuming runtime.lastError.
  return new Promise((resolve, reject) => {
    chrome.action.setIcon(details, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

export async function updateTab(tabId) {
  const token = ++sequence;
  requests.set(tabId, token);
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url;
    const [matches, stored] = await Promise.all([
      url ? chrome.bookmarks.search({ url }) : [],
      chrome.storage.local.get("resourceCounts")
    ]);
    if (requests.get(tabId) !== token) return;
    const bookmarks = matches.filter(bookmark => bookmark.url === url);
    const count = bookmarks.reduce((sum, bookmark) => {
      const value = stored.resourceCounts?.[bookmark.id];
      return sum + (Number.isSafeInteger(value) && value >= 0 ? value : 0);
    }, 0);
    const bookmarked = bookmarks.length > 0;
    const title = bookmarked ? t("Полка закладок · В закладках · Ресурсов: $1", [count]) : t("Полка закладок · Страница не в закладках");
    const imageData = Object.fromEntries([16, 32, 48].map(size => [size, toolbarIcon(bookmarked, count, size)]));
    await Promise.all([
      setTabIcon({ tabId, imageData }),
      chrome.action.setTitle({ tabId, title })
    ]);
  } catch (error) {
    if (!/^No tab with (?:id:|given id)|^Invalid tab ID:/i.test(error.message)) throw error;
  } finally {
    if (requests.get(tabId) === token) requests.delete(tabId);
  }
}

async function refreshAll() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(tab => updateTab(tab.id)));
  } catch (error) { console.warn(t("Не удалось обновить значки вкладок"), error); }
}

const refreshTab = tabId => { updateTab(tabId).catch(error => console.warn(t("Не удалось обновить значок вкладки"), error)); };
chrome.tabs.onActivated.addListener(({ tabId }) => refreshTab(tabId));
chrome.tabs.onCreated.addListener(tab => refreshTab(tab.id));
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.url !== undefined || change.status === "complete") refreshTab(tabId); });
chrome.tabs.onRemoved.addListener(tabId => requests.delete(tabId));
for (const event of [chrome.bookmarks.onCreated, chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved, chrome.bookmarks.onImportEnded]) event.addListener(refreshAll);
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.resourceCounts) refreshAll(); });
chrome.runtime.onInstalled.addListener(refreshAll);
chrome.runtime.onStartup.addListener(refreshAll);
refreshAll();
