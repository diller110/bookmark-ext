import test from "node:test";
import assert from "node:assert/strict";
import { crc32, createZip, readZip } from "../scripts/zip.mjs";
import { releaseFiles, validateRelease } from "../scripts/release-files.mjs";

test("release ZIP has reproducible bytes, valid checksums and no development files", async () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const small = [{ path: "manifest.json", data: Buffer.from("{}") }, { path: "src/пример.js", data: Buffer.from("export {};") }];
  const zip = createZip(small);
  assert.deepEqual(readZip(zip), small);
  assert.ok(zip.equals(createZip(small)));
  const files = await releaseFiles();
  assert.equal(validateRelease(files).manifest_version, 3);
  assert.throws(() => validateRelease([...files, { path: ".env", data: Buffer.from("SECRET=x") }]), /Private|match/);
  assert.throws(() => validateRelease([...files, { path: "src/secret.js", data: Buffer.from("ghp_" + "x".repeat(32)) }]), /Possible secret/);
  assert.throws(() => validateRelease(files.filter(file => file.path !== "vendor/sql-wasm.wasm")), /Missing|assert/);
  assert.throws(() => readZip(createZip([{ path: "../.env", data: Buffer.from("x") }])), /Unsafe ZIP path/);
});
