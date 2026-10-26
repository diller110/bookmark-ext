import assert from "node:assert/strict";
import { readdir, readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkLocales } from "./locales.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
let references = 0;
async function checkReference(path, base) {
  if (!path || /^(?:[a-z]+:|#)/i.test(path)) return;
  const target = new URL(path.split(/[?#]/)[0], base);
  assert.ok(target.href.startsWith(root.href), `Reference leaves the project: ${path}`);
  await access(target).catch(() => { throw new Error(`Missing file ${path} referenced by ${fileURLToPath(base)}`); });
  references++;
}
for (const path of [manifest.background.service_worker, manifest.options_page, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) await checkReference(path, root);

for (const folder of ["src/", "tests/", "scripts/", ""]) {
  for (const name of await readdir(new URL(folder, root))) {
    if (!/\.(?:js|mjs|html|css)$/.test(name)) continue;
    const url = new URL(folder + name, root);
    const source = await readFile(url, "utf8");
    if (/\.(?:js|mjs)$/.test(name)) {
      const result = spawnSync(process.execPath, ["--check", fileURLToPath(url)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      // Browser test callbacks import relative to their fixture page, so check their paths at runtime.
      if (folder !== "scripts/") {
        for (const match of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) await checkReference(match[1], url);
      }
      if (folder === "src/") {
        for (const match of source.matchAll(/new URL\(["'](\.[^"']+)["'],\s*import\.meta\.url\)/g)) await checkReference(match[1], url);
        for (const match of source.matchAll(/runtime\.getURL\(["']([^"']+)["']\)/g)) {
          if (!match[1].startsWith("/_favicon/")) await checkReference(match[1], root);
        }
      }
    } else if (name.endsWith(".html")) {
      for (const match of source.matchAll(/(?:src|href)="([^"?]+)(?:\?[^\"]*)?"/g)) await checkReference(match[1], url);
    } else {
      for (const match of source.matchAll(/url\(["']?([^"')]+)["']?\)/g)) await checkReference(match[1], url);
    }
  }
}
assert.ok(manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"), "SQLite requires the WASM CSP directive");
const localized = await checkLocales();
console.log(`Checked ${localized.messages} messages in ${localized.locales.length} locales.`);
console.log(`Project syntax and ${references} local references verified.`);
