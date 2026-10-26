import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const requests = [];
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext();
  await context.route("http://*.fixture.test/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    requests.push({ pathname, cookie: request.headers().cookie || "" });
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Media CORS fixture</title>" });
    if (pathname === "/playlist.m3u8") return route.fulfill({ headers, contentType: "application/vnd.apple.mpegurl", body: "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nvideo.mp4\n#EXT-X-ENDLIST\n" });
    if (pathname === "/video.mp4" || pathname === "/private.mp4") {
      if (pathname === "/private.mp4" && !request.headers().cookie?.includes("fixtureAuth=1")) return route.fulfill({ status: 401, headers, body: "" });
      return route.fulfill({ headers: { ...headers, "Content-Length": "5" }, contentType: "video/mp4", body: request.method() === "HEAD" ? "" : "video" });
    }
    if (!/^\/[a-z0-9/_-]+\.js$/i.test(pathname)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: "text/javascript", body: await readFile(new URL(".." + pathname, import.meta.url)) });
  });
  await context.addCookies([{ name: "fixtureAuth", value: "1", url: "http://page.fixture.test" }]);
  const page = await context.newPage();
  await page.goto("http://page.fixture.test/");
  const result = await page.evaluate(async () => {
    const { fetchPageMedia } = await import("./src/page-media.js");
    const { readMediaSize } = await import("./src/media-size.js");
    const { planStream } = await import("./src/stream-download.js");
    const base = "http://page.fixture.test";
    let oldRequestBlocked = false;
    try { await fetch("http://cdn.fixture.test/video.mp4", { credentials: "include" }); }
    catch (error) { oldRequestBlocked = error instanceof TypeError; }
    const candidate = { url: "http://cdn.fixture.test/video.mp4", kind: "video", downloadable: true, type: "video/mp4" };
    const publicFile = await fetchPageMedia(candidate);
    const privateFile = await fetchPageMedia({ ...candidate, url: `${base}/private.mp4` });
    const plan = await planStream({ ...candidate, url: "http://cdn.fixture.test/playlist.m3u8", transport: "hls" });
    return { oldRequestBlocked, publicFile: await publicFile.text(), privateFile: await privateFile.text(),
      publicSize: await readMediaSize(candidate.url), privateSize: await readMediaSize(`${base}/private.mp4`), tracks: plan.tracks.length };
  });
  assert.deepEqual(result, { oldRequestBlocked: true, publicFile: "video", privateFile: "video", publicSize: 5, privateSize: 5, tracks: 1 });
  assert.deepEqual(requests.filter(request => request.pathname === "/private.mp4").map(request => Boolean(request.cookie)), [false, true, false, true]);
  console.log("Verified Chrome blocks the original credentialed wildcard-CORS request, while public media, HLS manifests and HEAD probes succeed; private media and size probes retry with real cookies.");
} finally {
  await browser.close();
}
