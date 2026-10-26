import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../vendor/", import.meta.url);
const files = {};
async function scan(folder = "") {
  for (const entry of (await readdir(new URL(folder, root), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = folder + entry.name;
    if (entry.isDirectory()) await scan(path + "/");
    else if (path !== "integrity.json") files[path] = createHash("sha256").update(await readFile(new URL(path, root))).digest("hex");
  }
}
await scan();
if (process.argv.includes("--update")) {
  await writeFile(new URL("integrity.json", root), JSON.stringify(files, null, 2) + "\n");
  console.log("Vendor integrity snapshot updated; review dependency provenance before committing it.");
} else {
  assert.deepEqual(files, JSON.parse(await readFile(new URL("integrity.json", root), "utf8")), "Vendor files differ from the reviewed snapshot");
  console.log(`Verified SHA-256 for ${Object.keys(files).length} vendored files. This is not a vulnerability audit.`);
}
