import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scenarios = (await readdir(new URL("./", import.meta.url))).filter(name => /^verify-.+\.mjs$/.test(name)).sort();
const failures = [];
for (const name of scenarios) {
  console.log(`\nRunning ${name}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => resolve(code));
  });
  if (code !== 0) failures.push(name);
}
if (failures.length) {
  console.error(`\nFailed: ${failures.join(", ")}`);
  process.exitCode = 1;
} else console.log(`\nAll ${scenarios.length} browser scenarios passed.`);
