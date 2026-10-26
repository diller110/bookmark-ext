import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const packages = [
  ["m3u8-parser", "7.2.0", "CRatFqpjVtMiMaKXxNvuI3I++vUumIXVVT/JpCpdU/FynV/ceVw1qpPyyBNindL+JlPMSesx+WX1QJaZEJSaMQ==", { "dist/m3u8-parser.js": "m3u8-parser.js", LICENSE: "m3u8-LICENSE" }],
  ["mpd-parser", "1.4.0", "blbA7XpAaOdC/PR0Tu8GiUxlx6CpBuRowQPYV7lhi9Yr9G9+dkPXIUjqjzc/NCn/uZZPopluaJlIYntIEI/VLw==", { "dist/mpd-parser.js": "mpd-parser.js", LICENSE: "mpd-LICENSE" }],
  ["@ffmpeg/ffmpeg", "0.12.15", "1C8Obr4GsN3xw+/1Ww6PFM84wSQAGsdoTuTWPOj2OizsRDLT4CXTaVjPhkw6ARyDus1B9X/L2LiXHqYYsGnRFw==", null],
  ["@ffmpeg/core", "0.12.10", "dzNplnn2Nxle2c2i2rrDhqcB19q9cglCkWnoMTDN9Q9l3PvdjZWd1HfSPjCNWc/p8Q3CT+Es9fWOR0UhAeYQZA==", { "dist/esm/ffmpeg-core.js": "ffmpeg-core.js", "dist/esm/ffmpeg-core.wasm": "ffmpeg-core.wasm", "package.json": "core-package.json" }]
];
const destination = new URL("../vendor/streaming/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const [name, version, integrity, selected] of packages) {
  const short = name.split("/").pop();
  const response = await fetch(`https://registry.npmjs.org/${name}/-/${short}-${version}.tgz`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha512").update(data).digest("base64") !== integrity) throw new Error(`Integrity mismatch: ${name}`);
  const archive = path.join(tmpdir(), `bookmark-streaming-${crypto.randomUUID()}.tgz`);
  await writeFile(archive, data);
  try {
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split(/\r?\n/);
    const files = selected || Object.fromEntries(entries.filter(entry => /^package\/dist\/esm\/.*\.js$/.test(entry)).map(entry => [entry.slice(8), entry.split("/").pop()]));
    if (name === "@ffmpeg/ffmpeg") files["package.json"] = "wrapper-package.json";
    for (const [source, target] of Object.entries(files)) {
      const bytes = execFileSync("tar", ["-xOf", archive, `package/${source}`], { maxBuffer: 64 * 1024 * 1024 });
      await writeFile(new URL(target, destination), bytes);
    }
    const license = entries.find(entry => /^package\/LICENSE(?:\.\w+)?$/i.test(entry));
    if (license && !files.LICENSE) await writeFile(new URL(`${short}-LICENSE`, destination), execFileSync("tar", ["-xOf", archive, license]));
    console.log(`${name}@${version}: ${Object.keys(files).length} files`);
  } finally { await unlink(archive); }
}
await writeFile(new URL("package.json", destination), '{"type":"module"}\n');

// Preserve the reviewed local-only loader after refreshing the pinned upstream files.
async function patchVendor(name, changes) {
  const file = new URL(name, destination);
  let source = await readFile(file, "utf8");
  for (const [pattern, replacement] of changes) {
    if ([...source.matchAll(new RegExp(pattern.source, "g"))].length !== 1) throw new Error(`Review the local-only FFmpeg patch: ${name}`);
    source = source.replace(pattern, replacement);
  }
  await writeFile(file, source);
}
await patchVendor("const.js", [[/export const CORE_VERSION = [^\n]+;\nexport const CORE_URL = [^\n]+;/, `export const CORE_VERSION = "0.12.10";
export const CORE_URL = new URL("./ffmpeg-core.js", import.meta.url).href;
// CWS requires bundled executable assets, including unused dependency fallbacks.
export function localAssetURL(value, name) {
    const bundled = new URL(name, import.meta.url).href;
    if (value !== undefined && new URL(value, import.meta.url).href !== bundled)
        throw new Error("FFmpeg only supports bundled executable assets");
    return bundled;
}`]]);
await patchVendor("worker.js", [
  [/import \{ CORE_URL, FFMessageType \} from "\.\/const.js";/, 'import { localAssetURL, FFMessageType } from "./const.js";\nimport createFFmpegCore from "./ffmpeg-core.js";'],
  [/ERROR_NOT_LOADED, ERROR_IMPORT_FAILURE,/, "ERROR_NOT_LOADED,"],
  [/    try \{[\s\S]*?    ffmpeg = await self.createFFmpegCore\(\{/, `    const coreURL = localAssetURL(_coreURL, "./ffmpeg-core.js");
    const wasmURL = localAssetURL(_wasmURL, "./ffmpeg-core.wasm");
    if (_workerURL !== undefined) throw new Error("The bundled FFmpeg core is single-threaded");
    ffmpeg = await createFFmpegCore({`],
  [/JSON.stringify\(\{ wasmURL, workerURL \}\)/, "JSON.stringify({ wasmURL })"]
]);
await patchVendor("classes.js", [
  [/import \{ FFMessageType \} from "\.\/const.js";/, 'import { FFMessageType, localAssetURL } from "./const.js";'],
  [/            this\.#worker = classWorkerURL \?[\s\S]*?            this\.#registerHandlers\(\);/, '            const workerURL = localAssetURL(classWorkerURL, "./worker.js");\n            this.#worker = new Worker(workerURL, { type: "module" });\n            this.#registerHandlers();']
]);
for (const [name, url] of [
  ["ffmpeg-LICENSE", "https://raw.githubusercontent.com/ffmpegwasm/ffmpeg.wasm/v12.15/LICENSE"],
  ["GPL-2.0.txt", "https://raw.githubusercontent.com/FFmpeg/FFmpeg/n5.1.4/COPYING.GPLv2"],
  ["Apache-2.0.txt", "https://www.apache.org/licenses/LICENSE-2.0.txt"]
]) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`License ${name}: HTTP ${response.status}`);
  await writeFile(new URL(name, destination), await response.text());
}
