import { t } from "./i18n.js";
export function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    let id;
    if (url.hostname === "youtu.be") id = url.pathname.slice(1);
    else if (["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"].includes(url.hostname)) {
      id = url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:embed|shorts|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
  } catch { return null; }
}

export async function prepareYoutubePreview(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error(t("Некорректный адрес видео YouTube"));
  if (!await chrome.permissions.contains({ origins: ["https://www.youtube.com/*"], permissions: ["declarativeNetRequestWithHostAccess"] })) throw new Error(t("Разрешите доступ к YouTube и настройке заголовка для превью"));
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [73401],
    addRules: [{ id: 73401, priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: `https://${chrome.runtime.id}/` }] },
      condition: { initiatorDomains: [chrome.runtime.id], urlFilter: "|https://www.youtube.com/embed/", resourceTypes: ["sub_frame"] }
    }]
  });
  return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1&rel=0`;
}
