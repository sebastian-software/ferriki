import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FERRIKI_NODE_MIN_VERSION,
  FERRIKI_PLATFORM_TARGETS,
  formatFerrikiPlatformMatrix,
  resolveFerrikiPlatformTarget,
} from "../ferriki/platforms.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ferrikiManifest = JSON.parse(
  await readFile(join(nodeRoot, "ferriki", "package.json"), "utf8"),
);

assert.equal(FERRIKI_NODE_MIN_VERSION, "22.13.0");
assert.deepEqual(
  FERRIKI_PLATFORM_TARGETS.map((target) => target.id),
  ["linux-x64-gnu", "linux-arm64-gnu", "darwin-arm64", "darwin-x64", "win32-x64-msvc"],
);
assert.equal(
  resolveFerrikiPlatformTarget({ platform: "linux", arch: "x64", libc: "gnu" }).id,
  "linux-x64-gnu",
);
assert.equal(
  resolveFerrikiPlatformTarget({ platform: "linux", arch: "x64", libc: "musl" }),
  undefined,
);
assert.equal(resolveFerrikiPlatformTarget({ platform: "win32", arch: "x64" }).id, "win32-x64-msvc");
assert.equal(resolveFerrikiPlatformTarget({ platform: "win32", arch: "arm64" }), undefined);
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
}

console.log("Ferriki platform matrix verified (GNU Linux only; musl explicitly unsupported)");
