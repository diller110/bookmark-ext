import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../docs/chrome-web-store/", import.meta.url);
const gates = JSON.parse(await readFile(new URL("readiness.json", root), "utf8"));
assert.ok(Array.isArray(gates) && gates.length >= 4, "Publication gates must not be removed to bypass review");
for (const gate of gates) {
  assert.ok(["PASS", "FAIL", "UNKNOWN"].includes(gate.status));
  assert.match(gate.evidence, /^[a-z-]+\.md$/);
  if (gate.status === "PASS") await access(new URL(gate.evidence, root));
}
const blockers = gates.filter(gate => gate.status !== "PASS");
if (blockers.length) {
  console.error("Publication is blocked; the ZIP is a release candidate, not an approved submission:");
  for (const gate of blockers) console.error(`${gate.status} ${gate.id}: ${gate.reason} (${gate.evidence})`);
  process.exitCode = 1;
} else console.log("PASS: recorded publication gates. Google review remains independent.");
