import { t } from "./i18n.js";
import { ensureWorker } from "./download-manager.js";

export function registerSharedLibraryBridge() {
  if (chrome.extension.inIncognitoContext) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith("shared-library/") || !change.newValue?.request) continue;
      void respond(key, change.newValue).catch(console.warn);
    }
  });
}

async function respond(key, message) {
  if (Date.now() - message.at > 60000) { await chrome.storage.local.remove(key); return; }
  let response;
  try {
    await ensureWorker();
    response = await chrome.runtime.sendMessage({ target: "shared-library", payload: message.request });
    if (!response) throw new Error(t("Общая библиотека недоступна"));
  } catch (error) { response = { error: error.message }; }
  if (response.ok === false) response = { error: response.error };
  else if (response.ok) response = { value: response.value ?? null };
  await chrome.storage.local.set({ [key]: { response, at: Date.now() } });
  const stored = await chrome.storage.local.get(null);
  const expired = Object.keys(stored).filter(name => name.startsWith("shared-library/") && Date.now() - stored[name].at > 60000);
  if (expired.length) await chrome.storage.local.remove(expired);
}
