import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageRoot = join(nodeRoot, "ferriki");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

assert.deepEqual(
  Object.keys(packageJson.exports).sort(),
  [".", "./native", "./package.json"],
  "Ferriki must expose only the high-level API, native loader, and package metadata",
);

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  const values = packageJson[field] || {};
  for (const dependency of Object.keys(values)) {
    assert(
      !/shiki|wasm|oniguruma|regex|textmate/i.test(dependency),
      `native-only package must not declare a legacy runtime dependency: ${dependency}`,
    );
  }
}

const nativeLoader = await readFile(join(packageRoot, "native.mjs"), "utf8");
const forbiddenText = ["FERRIKI_BACKEND", "createJavaScriptRegexEngine", "createOnigurumaEngine"];

for (const phrase of forbiddenText)
  assert(
    !nativeLoader.includes(phrase),
    `native.mjs reintroduces removed runtime capability: ${phrase}`,
  );

const forbiddenExtensions = [".wasm", ".mjs.map"];
const forbiddenPath = /(?:^|\/)(?:chunks|shiki-rust|engine-javascript|engine-oniguruma)(?:\/|$)/;

async function walk(relative = "") {
  const directory = join(packageRoot, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(child)));
    else files.push(child);
  }
  return files;
}

for (const relative of await walk()) {
  assert(
    !forbiddenPath.test(relative),
    `native-only package contains forbidden runtime path: ${relative}`,
  );
  assert(
    !forbiddenExtensions.some((extension) => relative.endsWith(extension)),
    `native-only package contains forbidden runtime file: ${relative}`,
  );
}

console.log("Ferriki native-only package boundary verified");
