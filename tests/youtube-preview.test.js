import test from "node:test";
import assert from "node:assert/strict";
import { youtubeVideoId, prepareYoutubePreview } from "../src/youtube-preview.js";

// Synthetic ID: these tests never request a real video.

test("YouTube preview accepts known video URLs without trusting lookalike domains", () => {
  for (const url of ["https://www.youtube.com/watch?v=testVideo01", "https://youtu.be/testVideo01?t=30", "https://m.youtube.com/shorts/testVideo01", "https://www.youtube-nocookie.com/embed/testVideo01"]) {
    assert.equal(youtubeVideoId(url), "testVideo01");
  }
  for (const url of ["https://youtube.com.evil.test/watch?v=testVideo01", "https://www.youtube.com/watch?v=bad", "javascript:alert(1)", "https://user:secret@youtube.com/watch?v=testVideo01"]) assert.equal(youtubeVideoId(url), null);
});

test("YouTube player identifies only this extension's embed requests and requires host access", async () => {
  const previous = globalThis.chrome;
  let rules;
  let allowed = false;
  globalThis.chrome = { runtime: { id: "abcdefghijklmnopabcdefghijklmnop" }, permissions: { contains: async () => allowed },
    declarativeNetRequest: { updateSessionRules: async value => { rules = value; } } };
  try {
    await assert.rejects(prepareYoutubePreview("testVideo01"), /Разрешите доступ/);
    assert.equal(rules, undefined);
    allowed = true;
    const url = new URL(await prepareYoutubePreview("testVideo01"));
    assert.equal(url.origin, "https://www.youtube.com");
    assert.equal(url.pathname, "/embed/testVideo01");
    const [rule] = rules.addRules;
    assert.deepEqual(rule.condition, { initiatorDomains: [chrome.runtime.id], urlFilter: "|https://www.youtube.com/embed/", resourceTypes: ["sub_frame"] });
    assert.deepEqual(rule.action.requestHeaders, [{ header: "Referer", operation: "set", value: `https://${chrome.runtime.id}/` }]);
    assert.deepEqual(rules.removeRuleIds, [rule.id]);
    await assert.rejects(prepareYoutubePreview("../malicious"), /Некорректный/);
  } finally { globalThis.chrome = previous; }
});
