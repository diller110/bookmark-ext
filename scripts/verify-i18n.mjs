import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { messageId } from "../src/i18n.js";
import { supportedLocales } from "./locales.mjs";

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const locale of [...supportedLocales.map(locale => locale.replace("_", "-")), "uk"]) {
  const catalog = JSON.parse(await readFile(join(root, "_locales", locale === "uk" ? "en" : locale.replace("-", "_"), "messages.json"), "utf8"));
  const expected = source => catalog[messageId(source)].message;
  const profile = await mkdtemp(join(root, ".test-incognito-i18n-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome", headless: true, locale, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging", `--lang=${locale}`]
  });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: root });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/popup.html`);
    const actualLocale = await page.evaluate(() => chrome.i18n.getUILanguage());
    assert.equal(actualLocale.toLowerCase(), locale.toLowerCase(), "Chrome must use the requested native catalog");
    assert.equal(await page.evaluate(() => chrome.runtime.getManifest().name), expected("Полка закладок"));
    await page.waitForFunction(() => !document.querySelector("#search").disabled);
    assert.equal(await page.locator("#app-title").textContent(), expected("Закладки"));
    assert.equal(await page.locator("#search").getAttribute("placeholder"), expected("Поиск закладок"));
    assert.equal(await page.locator("#collections-toggle").textContent(), expected("Подборки"));
    assert.equal(await page.locator("html").getAttribute("dir"), locale === "ar" ? "rtl" : "ltr");
    const probe = await page.evaluate(async () => {
      const { t, localizeDocument } = await import("./src/i18n.js");
      const { formatFileSize } = await import("./src/file-size.js");
      const node = document.createElement("span");
      node.textContent = "Закладки";
      node.title = "Закладки";
      document.body.append(node);
      localizeDocument(document);
      const result = { text: node.textContent, title: node.title,
        substituted: t("Открыть ресурс: $1", ["Закладки <b>$1</b>"]), size: formatFileSize(1.5 * 1024 ** 2) };
      node.remove();
      return result;
    });
    assert.equal(probe.text, "Закладки", "Later user text must not be translated");
    assert.equal(probe.title, "Закладки", "Later user attributes must not be translated");
    assert.equal(probe.substituted, expected("Открыть ресурс: $1").replace("$p1$", "Закладки <b>$1</b>"));
    assert.ok(probe.size.includes(new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(1.5)));
    if (locale !== "ru") assert.ok(!/[А-Яа-яЁё]/.test(await page.locator("#app-header").innerText()));
    await mkdir(join(root, "release", "localization"), { recursive: true });
    await page.screenshot({ path: join(root, "release", "localization", `${locale}-bookmarks.png`) });
    await page.goto(`chrome-extension://${id}/settings.html`);
    assert.equal(await page.title(), expected("Настройки · Полка закладок"));
    assert.equal(await page.locator("#choose-folder").textContent(), expected("Выбрать папку"));
    await page.goto(`chrome-extension://${id}/tab.html`);
    assert.equal(await page.title(), expected("Текущая вкладка · Полка закладок"));
    assert.equal(await page.locator("#download-clear").textContent(), expected("Очистить завершённые"));
    assert.deepEqual(errors, []);
    console.log(`Verified native ${locale} UI: three pages, attributes, substitutions, number formatting and untouched user text.`);
  } finally {
    await context.close();
    assert.equal(dirname(resolve(profile)), root);
    assert.ok(basename(profile).startsWith(".test-incognito-i18n-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
