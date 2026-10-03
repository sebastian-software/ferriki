import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repositoryRoot = dirname(nodeRoot);
const packageRoot = join(nodeRoot, "ferriki");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

assert.deepEqual(
  Object.keys(packageJson.exports).sort(),
  [".", "./package.json"],
  "Ferriki must expose only the high-level API and package metadata; the native loader stays internal",
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

function cargoTree(args) {
  const result = spawnSync("cargo", ["tree", ...args, "--prefix", "none", "--locked"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || "cargo tree failed");
  return result.stdout;
}

const addonDependencies = cargoTree(["-p", "ferriki-core"]);
assert(
  !/^ureq v/m.test(addonDependencies) && !/^rustls v/m.test(addonDependencies),
  "the N-API addon must not pull in the Rust HTTP or TLS stack",
);
const rustRemoteDependencies = cargoTree(["-p", "ferriki", "--features", "remote"]);
assert(
  /^ureq v/m.test(rustRemoteDependencies) && /^rustls v/m.test(rustRemoteDependencies),
  "the Rust remote feature must retain its HTTP and TLS transport",
);

console.log("Ferriki native-only package and asset transport boundaries verified");
