import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const target = fileURLToPath(new URL("../release/store-assets/", import.meta.url));
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./verify-resource-grid.mjs", import.meta.url)), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, STORE_SCREENSHOTS: target }
  });
  child.on("error", reject); child.on("exit", resolve);
});
assert.equal(code, 0, "Store screenshot scenario failed");
console.log(`Anonymous fixture screenshots (1280 x 800): ${target}`);
