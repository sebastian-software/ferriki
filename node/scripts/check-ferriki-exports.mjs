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
  "./package.json",
  "./react/macro",
]);

const macro = await import("../ferriki/macro.mjs");
assert.deepEqual(Object.keys(macro), ["code"]);
assert.throws(
  () => macro.code("const answer = 42", { language: "js" }),
  /@ferriki\/vite/,
  "an unprocessed macro must explain how to enable its build integration",
);

const reactMacro = await import("../ferriki/react-macro.mjs");
assert.deepEqual(Object.keys(reactMacro), ["Code"]);
assert.throws(
  () => reactMacro.Code({ source: "const answer = 42", language: "js" }),
  /@ferriki\/vite.*before your React plugin/,
  "an unprocessed React macro must explain its build integration and ordering",
);

console.log("Ferriki public export surface verified");
