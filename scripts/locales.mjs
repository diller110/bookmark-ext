import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { messageId } from "../src/i18n.js";

export const supportedLocales = ["ru", "en", "es", "pt_BR", "fr", "de", "it", "zh_CN", "ja", "ko", "ar", "hi"];

export function validateLocales(files, manifest) {
  const catalogs = new Map(files.filter(file => /^_locales\/[^/]+\/messages\.json$/.test(file.path))
    .map(file => [file.path.split("/")[1], JSON.parse(file.data.toString("utf8"))]));
  assert.ok(catalogs.has(manifest.default_locale), "Missing default locale");
  assert.deepEqual([...catalogs.keys()].sort(), [...supportedLocales].sort(), "Missing or unexpected locale");
  const canonical = catalogs.get("ru");
  assert.ok(canonical, "Missing Russian source catalog");
  const keys = Object.keys(canonical).sort();
  for (const [locale, catalog] of catalogs) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, `Incomplete locale ${locale}`);
    for (const [id, entry] of Object.entries(catalog)) {
      const source = canonical[id].description;
      assert.equal(id, messageId(source), `Message ID mismatch in ${locale}: ${id}`);
      assert.equal(entry.description, source, `Message source mismatch in ${locale}: ${id}`);
      assert.ok(typeof entry.message === "string" && entry.message.trim(), `Empty ${locale} message ${id}`);
      assert.ok(!/<\/?(?:script|style|iframe|img)\b/i.test(entry.message), `HTML in ${locale} message ${id}`);
      const expected = [...source.matchAll(/\$([1-9])/g)].map(match => `p${match[1]}`).sort();
      const actual = [...entry.message.matchAll(/\$([a-z][a-z0-9_]*)\$/gi)].map(match => match[1]).sort();
      assert.deepEqual(actual, expected, `Placeholder mismatch in ${locale}: ${source}`);
      const placeholders = Object.fromEntries([...new Set(expected)].map(name => [name, { content: `$${name.slice(1)}` }]));
      assert.deepEqual(entry.placeholders || {}, placeholders, `Invalid placeholders in ${locale}: ${id}`);
    }
    for (const [value, maximum] of [[manifest.name, 75], [manifest.description, 132], [manifest.action.default_title, 75]]) {
      const match = /^__MSG_(\w+)__$/.exec(value);
      assert.ok(match && catalog[match[1]], `Missing localized manifest entry ${locale}: ${value}`);
      assert.ok(catalog[match[1]].message.length <= maximum, `Localized manifest text too long in ${locale}: ${value}`);
    }
  }
  for (const { path, data } of files.filter(file => file.path.startsWith("src/") && file.path.endsWith(".js"))) {
    for (const match of data.toString("utf8").matchAll(/\bt\(\s*("(?:[^"\\]|\\.)*")/g)) {
      const source = JSON.parse(match[1]);
      assert.equal(canonical[messageId(source)]?.description, source, `Uncatalogued text in ${path}: ${source}`);
    }
  }
  for (const { path, data } of files.filter(file => file.path.endsWith(".html"))) {
    const source = data.toString("utf8");
    const messages = [...source.matchAll(/>([^<>]+)</g)].map(match => match[1].trim())
      .concat([...source.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map(match => match[1]));
    for (const text of messages.filter(text => /[А-Яа-яЁё]/.test(text))) {
      assert.equal(canonical[messageId(text)]?.description, text, `Uncatalogued HTML in ${path}: ${text}`);
    }
  }
  return { locales: [...catalogs.keys()], messages: keys.length };
}

export async function checkLocales() {
  const root = new URL("../", import.meta.url);
  const files = [];
  for (const locale of await readdir(new URL("_locales/", root))) {
    const path = `_locales/${locale}/messages.json`;
    files.push({ path, data: await readFile(new URL(path, root)) });
  }
  for (const name of await readdir(new URL("src/", root))) {
    if (name.endsWith(".js")) files.push({ path: `src/${name}`, data: await readFile(new URL(`src/${name}`, root)) });
  }
  for (const name of ["popup.html", "tab.html", "settings.html", "download-offscreen.html"]) files.push({ path: name, data: await readFile(new URL(name, root)) });
  return validateLocales(files, JSON.parse(await readFile(new URL("manifest.json", root))));
}
