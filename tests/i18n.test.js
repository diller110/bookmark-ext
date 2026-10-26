import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { messageId, t, uiLocale } from "../src/i18n.js";
import { collectPageMedia, pageMediaMessages } from "../src/page-media.js";
import { readFrameBlob, frameBlobMessages } from "../src/media-scan.js";
import { formatFileSize } from "../src/file-size.js";
import { releaseFiles } from "../scripts/release-files.mjs";
import { validateLocales } from "../scripts/locales.mjs";

test("localization uses native catalogs, keeps fallback and never translates substituted user content", async () => {
  const previous = globalThis.chrome;
  const en = JSON.parse(await readFile(new URL("../_locales/en/messages.json", import.meta.url)));
  try {
    delete globalThis.chrome;
    assert.equal(messageId("hello"), "m_4f9f2cab");
    assert.equal(uiLocale(), "ru");
    assert.equal(t("$2 / $1", ["<b>$2</b>", "Русское имя"]), "Русское имя / <b>$2</b>");
    globalThis.chrome = { i18n: {
      getUILanguage: () => "en_US",
      getMessage(id, values) {
        const entry = en[id];
        return entry?.message.replace(/\$(p[1-9])\$/g, (_match, name) => values[Number(entry.placeholders[name].content.slice(1)) - 1]) || "";
      }
    } };
    assert.equal(uiLocale(), "en-US");
    assert.equal(t("Закладки"), "Bookmarks");
    assert.equal(t("Открыть ресурс: $1", ["Закладки <b>$1</b>"]), "Open resource: Закладки <b>$1</b>");
    assert.equal(t("Missing $1", ["value"]), "Missing value");
    assert.equal(formatFileSize(1.5 * 1024 ** 2), "1.5 MB");

    const context = vm.createContext({ location: { href: "https://fixture.test/changed" } });
    const pageMessages = pageMediaMessages();
    const blobMessages = frameBlobMessages();
    assert.throws(() => vm.runInContext(`(${collectPageMedia.toString()})('https://fixture.test/old', false, ${JSON.stringify(pageMessages)})`, context), /The frame URL has changed/);
    const blobResult = await vm.runInContext(`(${readFrameBlob.toString()})('blob:fixture', 'https://fixture.test/old', 'fixture', 0, false, ${JSON.stringify(blobMessages)})`, context);
    assert.equal(blobResult.error, "The frame URL has changed");
    for (const [func, messages] of [[collectPageMedia, pageMessages], [readFrameBlob, blobMessages]]) {
      for (const match of func.toString().matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
        assert.ok(messages[JSON.parse(match[1])], "Every injected message must cross the serialization boundary");
      }
    }
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});

test("all locale catalogs are complete and packaging rejects broken placeholders or manifest text", async () => {
  const files = await releaseFiles();
  const manifest = JSON.parse(files.find(file => file.path === "manifest.json").data);
  const result = validateLocales(files, manifest);
  assert.equal(result.locales.length, 12);
  assert.ok(result.messages >= 446);
  assert.throws(() => validateLocales(files.filter(file => file.path !== "_locales/fr/messages.json"), manifest), /Missing or unexpected locale/);
  const path = "_locales/en/messages.json";
  const broken = JSON.parse(files.find(file => file.path === path).data);
  delete broken[messageId("Закладки")];
  assert.throws(() => validateLocales(files.map(file => file.path === path ? { path, data: Buffer.from(JSON.stringify(broken)) } : file), manifest), /Incomplete locale/);
  const malformed = JSON.parse(files.find(file => file.path === path).data);
  malformed[messageId("Открыть ресурс: $1")].message = "Missing substitution";
  assert.throws(() => validateLocales(files.map(file => file.path === path ? { path, data: Buffer.from(JSON.stringify(malformed)) } : file), manifest), /Placeholder mismatch/);
  const oversized = JSON.parse(files.find(file => file.path === path).data);
  oversized[manifest.description.slice(6, -2)].message = "x".repeat(133);
  assert.throws(() => validateLocales(files.map(file => file.path === path ? { path, data: Buffer.from(JSON.stringify(oversized)) } : file), manifest), /manifest text too long/);
});
