import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readZip } from "./zip.mjs";
import { validateRelease, projectRoot } from "./release-files.mjs";

const manifest = JSON.parse(await readFile(new URL("manifest.json", projectRoot), "utf8"));
const archive = await readFile(new URL(`release/bookmark-shelf-${manifest.version}.zip`, projectRoot));
const files = readZip(archive);
validateRelease(files);
const root = new URL(`release/unpacked-${createHash("sha256").update(archive).digest("hex")}/`, projectRoot);
const actual = [];
async function scan(path = "") {
  for (const entry of await readdir(new URL(path, root), { withFileTypes: true })) {
    if (entry.isDirectory()) await scan(path + entry.name + "/");
    else actual.push(path + entry.name);
  }
}
await scan();
assert.deepEqual(actual.sort(), files.map(file => file.path).sort(), "Stale files in unpacked release; remove release/ and repack");
for (const { path, data } of files) assert.ok(data.equals(await readFile(new URL(path, root))), `Unpacked file differs: ${path}`);
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./verify-incognito.mjs", import.meta.url)), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, BOOKMARK_EXTENSION_ROOT: fileURLToPath(root) }
  });
  child.on("error", reject);
  child.on("exit", resolve);
});
assert.equal(code, 0, "Packaged extension smoke test failed");
console.log("Installed and exercised the verified ZIP contents in an isolated Chrome profile.");
