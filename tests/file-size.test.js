import test from "node:test";
import assert from "node:assert/strict";
import { formatFileSize } from "../src/file-size.js";

test("file sizes use bytes, KB, MB and GB with a readable decimal", () => {
  for (const [bytes, expected] of [
    [0, "0 Б"], [512, "512 Б"], [1024, "1 КБ"], [1536, "1,5 КБ"],
    [1024 ** 2, "1 МБ"], [12.5 * 1024 ** 2, "12,5 МБ"], [1.5 * 1024 ** 3, "1,5 ГБ"],
    [-1, "Размер неизвестен"], [NaN, "Размер неизвестен"]
  ]) assert.equal(formatFileSize(bytes), expected);
});
