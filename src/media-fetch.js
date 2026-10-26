import { assertDownloadSource } from "./download-policy.js";

export async function fetchMedia(url, options = {}) {
  assertDownloadSource(url);
  const checked = async response => {
    try { assertDownloadSource(response.url); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return response;
  };
  try {
    const response = await checked(await fetch(url, { ...options, credentials: "omit" }));
    if (![401, 403].includes(response.status) && !/text\/html/i.test(response.headers.get("Content-Type") || "")) return response;
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    if (options.signal?.aborted || !(error instanceof TypeError)) throw error;
  }
  return checked(await fetch(url, { ...options, credentials: "include" }));
}
