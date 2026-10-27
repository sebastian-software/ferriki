import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  FERRIKI_NODE_MIN_VERSION,
  FERRIKI_PLATFORM_TARGETS,
  formatFerrikiPlatformMatrix,
  resolveFerrikiPlatformTarget,
} from "../ferriki/platforms.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const workflowDir = join(nodeRoot, "..", ".github", "workflows");
const ferrikiManifest = JSON.parse(
  await readFile(join(nodeRoot, "ferriki", "package.json"), "utf8"),
);

assert.equal(FERRIKI_NODE_MIN_VERSION, "22.13.0");
assert.deepEqual(
  FERRIKI_PLATFORM_TARGETS.map((target) => target.id).sort(),
  [
    "linux-x64-gnu",
    "linux-arm64-gnu",
    "linux-x64-musl",
    "linux-arm64-musl",
    "darwin-arm64",
    "win32-x64-msvc",
    "win32-arm64-msvc",
  ].sort(),
);
assert.equal(
  resolveFerrikiPlatformTarget({ platform: "linux", arch: "x64", libc: "gnu" }).id,
  "linux-x64-gnu",
);
assert.equal(
  resolveFerrikiPlatformTarget({ platform: "linux", arch: "x64", libc: "musl" }).id,
  "linux-x64-musl",
);
assert.equal(
  resolveFerrikiPlatformTarget({ platform: "linux", arch: "arm64", libc: "musl" }).id,
  "linux-arm64-musl",
);
assert.equal(
  resolveFerrikiPlatformTarget({ platform: "linux", arch: "x64", libc: "unknown" }),
  undefined,
);
assert.equal(resolveFerrikiPlatformTarget({ platform: "darwin", arch: "x64" }), undefined);
assert.equal(resolveFerrikiPlatformTarget({ platform: "win32", arch: "x64" }).id, "win32-x64-msvc");
assert.equal(
  resolveFerrikiPlatformTarget({ platform: "win32", arch: "arm64" }).id,
  "win32-arm64-msvc",
);
assert.match(formatFerrikiPlatformMatrix(), /linux-arm64-gnu \(Node >= 22\.13\.0\)/);

for (const target of FERRIKI_PLATFORM_TARGETS) {
  assert.equal(
    ferrikiManifest.optionalDependencies?.[target.packageName],
    ferrikiManifest.version,
    `${target.id} must be declared as an optional dependency at the package version`,
  );
  const sidecar = JSON.parse(
    await readFile(join(nodeRoot, "platforms", target.id, "package.json"), "utf8"),
  );
  assert.equal(sidecar.name, target.packageName);
  assert.equal(
    sidecar.version,
    ferrikiManifest.version,
    `${target.id} sidecar must use the main package version`,
  );
  assert(sidecar.files.includes("ferriki.node"), `${target.id} sidecar must publish ferriki.node`);
  // npm rewrites a string `repository` on every publish; keep the normalized
  // object so provenance and npmjs.com link the exact package directory.
  assert.deepEqual(
    sidecar.repository,
    {
      type: "git",
      url: ferrikiManifest.repository.url,
      directory: `node/platforms/${target.id}`,
    },
    `${target.id} sidecar must declare its repository as an object with its directory`,
  );
}

// Every target must be built and smoke-tested in CI and built, collected and
// published by the release workflow. The workflows are plain YAML, so the check
// matches the exact lines that carry each platform id.
const platformIds = FERRIKI_PLATFORM_TARGETS.map((target) => target.id);
const ciWorkflow = await readFile(join(workflowDir, "ci.yml"), "utf8");
const publishWorkflow = await readFile(join(workflowDir, "publish.yml"), "utf8");
const matrix = JSON.parse(
  execFileSync(process.execPath, [join(nodeRoot, "scripts/native-matrix.mjs")], {
    encoding: "utf8",
  }),
);
assert.deepEqual(matrix.include.map((target) => target.id).sort(), [...platformIds].sort());
for (const workflow of [ciWorkflow, publishWorkflow]) {
  assert.match(workflow, /node scripts\/native-matrix\.mjs/);
  assert.match(workflow, /fromJSON\(needs\.native-matrix\.outputs\.matrix\)/);
}
assert.match(
  publishWorkflow,
  /uses: \.\/node\/node_modules\/ferramenta-native\/actions\/release-native/,
  "publish.yml must use the shared full-matrix artifact restoration",
);

console.log(`Ferriki platform matrix verified (${FERRIKI_PLATFORM_TARGETS.length} targets)`);
