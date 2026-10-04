import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const ferriki = await import("../ferriki/index.mjs");
for (const removed of [
  "codeToHast",
  "codeToTokens",
  "codeToTokensBase",
  "codeToTokensWithThemes",
  "hastToHtml",
  "createJavaScriptRegexEngine",
  "createOnigurumaEngine",
  "loadWasm",
  "wasmBinary",
  "__ferrikiBackend",
]) {
  assert.equal(Object.hasOwn(ferriki, removed), false, `${removed} must not be public Ferriki API`);
}

const packageJson = JSON.parse(await readFile(join(scriptDir, "../ferriki/package.json"), "utf8"));
assert.deepEqual(Object.keys(packageJson.exports).sort(), [
  ".",
  "./macro",
  "./macro-transform",
  "./package.json",
]);

const macro = await import("../ferriki/macro.mjs");
assert.deepEqual(Object.keys(macro), ["ferrikiCode"]);
assert.throws(
  () => macro.ferrikiCode("const answer = 42", { language: "js" }),
  /@ferriki\/vite/,
  "an unprocessed macro must explain how to enable its build integration",
);

console.log("Ferriki public export surface verified");
