import { t } from "./i18n.js";
import { collectPageMedia, pageMediaCandidates, pageMediaMessages } from "./page-media.js";
import { hostPattern } from "./media-scan.js";

export const pickedMediaKey = tabId => `pickedMedia:${tabId}`;

export async function startMediaPicker(tab) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  const available = [];
  const originOf = (frame, seen = new Set()) => {
    if (!frame || seen.has(frame.frameId)) return "";
    seen.add(frame.frameId);
    if (/^https?:/.test(frame.url)) return new URL(frame.url).origin;
    return /^about:(blank|srcdoc)/.test(frame.url) ? originOf(frames.find(parent => parent.frameId === frame.parentFrameId), seen) : "";
  };
  for (const frame of frames || []) {
    const origin = originOf(frame);
    if (!origin) continue;
    if (origin === new URL(tab.url).origin || await chrome.permissions.contains({ origins: [hostPattern(origin)] })) available.push({ ...frame, origin });
  }
  if (!available.length) throw new Error(t("На этой странице выбор ресурсов недоступен"));
  let finished = false;
  const cleanup = () => chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: available.map(frame => frame.frameId) }, func: () => globalThis.__bookmarkMediaPicker?.() }).catch(() => {});
  for (const frame of available) {
    void chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frame.frameId] }, func: collectPageMedia, args: [frame.url, true, pageMediaMessages()] }).then(async results => {
      if (finished) return;
      const candidates = pageMediaCandidates(results[0]?.result || [], { frameId: frame.frameId, frameUrl: frame.url, origin: frame.origin });
      finished = true;
      try {
        if (candidates.length && (await chrome.tabs.get(tab.id)).url === tab.url) {
          await chrome.storage.local.set({ [pickedMediaKey(tab.id)]: { url: tab.url, candidates } });
        }
      } finally { await cleanup(); }
    }).catch(error => console.warn(t("Выбор медиа во фрейме недоступен"), error));
  }
}

export function registerMediaPicker() {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "start-media-picker") return;
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url?.split("?")[0] !== chrome.runtime.getURL("tab.html")) return;
    (async () => {
      if (!Number.isInteger(message.tabId)) throw new Error(t("Некорректная вкладка"));
      const tab = await chrome.tabs.get(message.tabId);
      if (!/^https?:/.test(tab.url)) throw new Error(t("Откройте обычную веб-страницу"));
      await startMediaPicker(tab);
      respond({ ok: true });
    })().catch(error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.local.remove(pickedMediaKey(tabId)).catch(() => {}); });
}
