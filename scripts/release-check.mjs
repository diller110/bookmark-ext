import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const browserArgs = process.argv.slice(2).filter(value => value !== "--technical");

for (const [file, args] of [
  ["check-project.mjs", []], ["check-vendor.mjs", []],
  [null, ["--test", "tests/*.test.js"]], ["verify.mjs", browserArgs],
  ["release-pack.mjs", []], ["smoke-release.mjs", browserArgs]
]) {
  const command = file ? [fileURLToPath(new URL(file, import.meta.url)), ...args] : args;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command, { stdio: "inherit" });
    child.on("error", reject); child.on("exit", resolve);
  });
  assert.equal(code, 0, `Release gate failed: ${file || "unit tests"}`);
}
console.log("PASS: technical release gates. Store declarations and publisher verification still require manual completion.");
if (!process.argv.includes("--technical")) await import("./check-publication.mjs");
