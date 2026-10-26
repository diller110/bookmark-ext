import test from "node:test";
import assert from "node:assert/strict";
import { popupSize } from "../src/popup-size.js";

test("popup size restores finite dimensions within Chrome limits", () => {
  assert.deepEqual(popupSize(), { width: 780, height: 580 });
  assert.deepEqual(popupSize(null), { width: 780, height: 580 });
  assert.deepEqual(popupSize({ width: 720.4, height: 500.7 }), { width: 720, height: 501 });
  assert.deepEqual(popupSize({ width: 9000, height: 9000 }), { width: 800, height: 600 });
  assert.deepEqual(popupSize({ width: -10, height: 0 }), { width: 480, height: 360 });
  assert.deepEqual(popupSize({ width: "700", height: Infinity }), { width: 780, height: 580 });
});
