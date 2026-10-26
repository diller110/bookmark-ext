import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot, releaseFiles, validateRelease } from "./release-files.mjs";
import { createZip, readZip } from "./zip.mjs";
import "./check-vendor.mjs";

const files = await releaseFiles();
const manifest = validateRelease(files);
assert.equal(manifest.version, JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8")).version, "Manifest and package versions must match");
const archive = createZip(files);
assert.ok(archive.equals(createZip(files)), "Packaging is not reproducible");
const filename = `bookmark-shelf-${manifest.version}.zip`;
await mkdir(new URL("release/", projectRoot), { recursive: true });
const target = new URL(`release/${filename}`, projectRoot);
await writeFile(target, archive);
const unpacked = readZip(await readFile(target));
assert.deepEqual(unpacked, files, "ZIP contents differ from reviewed inputs");
validateRelease(unpacked);
const sha256 = createHash("sha256").update(archive).digest("hex");
for (const { path, data } of unpacked) {
  const target = new URL(`release/unpacked-${sha256}/${path}`, projectRoot);
  await mkdir(dirname(fileURLToPath(target)), { recursive: true });
  await writeFile(target, data);
}
await writeFile(new URL(`release/${filename}.sha256`, projectRoot), `${sha256}  ${filename}\n`);
await writeFile(new URL("release/contents.json", projectRoot), JSON.stringify({ version: manifest.version, sha256, files: files.map(({ path, data }) => ({ path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") })) }, null, 2) + "\n");
console.log(`Verified ${files.length} packaged files, ${archive.length} ZIP bytes, SHA-256 ${sha256}`);
console.log(fileURLToPath(target));
