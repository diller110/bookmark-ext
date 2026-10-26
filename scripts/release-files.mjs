import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { validateLocales } from "./locales.mjs";

export const projectRoot = new URL("../", import.meta.url);
const pages = ["manifest.json", "popup.html", "tab.html", "settings.html", "download-offscreen.html"];
export async function releaseFiles() {
  const paths = [...pages];
  async function scan(folder) {
    for (const entry of await readdir(new URL(folder, projectRoot), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `Symlinks are not allowed in a release: ${path}`);
      if (entry.isDirectory()) await scan(path);
      else {
        if (path.startsWith("src/")) assert.match(path, /\.(?:js|css)$/, `Unexpected source asset: ${path}`);
        if (path.startsWith("icons/")) assert.match(path, /\.(?:png|svg)$/, `Unexpected icon asset: ${path}`);
        paths.push(path);
      }
    }
  }
  for (const folder of ["src", "icons", "vendor", "_locales"]) await scan(folder);
  return Promise.all(paths.sort().map(async path => ({ path, data: await readFile(new URL(path, projectRoot)) })));
}

export function validateRelease(files) {
  const byPath = new Map(files.map(file => [file.path, file.data]));
  const manifest = JSON.parse(byPath.get("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+(?:\.\d+){0,3}$/);
  const version = manifest.version.split(".").map(Number);
  assert.ok(version.every(number => number <= 65535) && version.some(number => number > 0), "Invalid Chrome version");
  assert.ok(manifest.name && manifest.name.length <= 75);
  assert.ok(manifest.description && manifest.description.length <= 132);
  validateLocales(files, manifest);
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.incognito, "split");
  const required = ["bookmarks", "favicon", "tabs", "storage", "activeTab", "scripting", "webNavigation", "offscreen"];
  assert.deepEqual([...manifest.permissions].sort(), required.sort(), "Re-review required permissions when changing the release");
  assert.deepEqual(manifest.optional_permissions, ["declarativeNetRequestWithHostAccess"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "http://*/*"]);
  for (const key of ["externally_connectable", "web_accessible_resources", "content_scripts", "host_permissions"]) assert.equal(manifest[key], undefined, `Re-review ${key} before enabling it`);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
  for (const path of [manifest.background.service_worker, manifest.options_page, manifest.action.default_popup]) assert.ok(byPath.has(path), `Missing entry point ${path}`);
  for (const [size, path] of Object.entries(manifest.icons)) {
    const png = byPath.get(path);
    assert.ok(png && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Invalid icon ${path}`);
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
  const expected = (path, base) => {
    if (!path || /^(?:[a-z]+:|#)/i.test(path)) return;
    const url = new URL(path, `https://package.invalid/${base}`);
    assert.equal(url.origin, "https://package.invalid");
    assert.ok(byPath.has(url.pathname.slice(1)), `Missing packaged resource ${path} in ${base}`);
  };
  for (const { path, data } of files) {
    assert.match(path, /^(?:manifest\.json|(?:popup|tab|settings|download-offscreen)\.html|(?:src|icons|vendor)\/[^\\]+|_locales\/[a-z]{2}(?:_[A-Z]{2})?\/messages\.json)$/);
    assert.ok(!/(?:^|\/)(?:\.|node_modules|tests|scripts)|\.(?:test\.js|map|log|sqlite|har|zip|pem|key)$/i.test(path), `Private or development file in ZIP: ${path}`);
    if (!/\.(?:js|html|css|json|md|txt)$/.test(path)) continue;
    const source = data.toString("utf8");
    assert.ok(!/\b(?:eval\s*\(|new\s+Function\s*\(|importScripts\s*\()/m.test(source), `Unexpected dynamic execution in ${path}`);
    assert.ok(!/(?:github_pat_|ghp_)[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(source), `Possible secret in ${path}`);
    if (path.endsWith(".html")) {
      assert.ok(!/<script\b[^>]*>\s*[^<\s]/i.test(source), `Inline script in ${path}`);
      for (const match of source.matchAll(/(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/g)) expected(match[1], path);
    }
    if (path.endsWith(".js")) {
      for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
        assert.ok(match[1].startsWith("."), `Nonlocal executable import in ${path}`);
        expected(match[1], path);
      }
      for (const match of source.matchAll(/new URL\(["'](\.[^"']+)["'],\s*import\.meta\.url\)/g)) expected(match[1], path);
    }
    if (path.endsWith(".css")) for (const match of source.matchAll(/url\(["']?([^"')]+)["']?\)/g)) expected(match[1], path);
  }
  assert.ok(byPath.has("vendor/sql-wasm.wasm") && byPath.has("vendor/streaming/ffmpeg-core.wasm"));
  return manifest;
}
