/* eslint-disable security/detect-non-literal-fs-filename -- Paths are fixed relative to this script. */
// Measures what an install of Ferriki adds and commits the figures the
// footprint page states: the size of the linux-x64 native addon that
// `build:native` produced and of the packed `@ferriki/core` tarball. Those
// sizes depend on the toolchain, the checkout's paths and the package files, so
// another machine cannot reproduce them byte for byte. `--check` therefore
// verifies the committed record's shape, plus the one fact that is identical
// everywhere: the Rust lockfile names no crate of the OXC, SWC or Boa
// JavaScript toolchains. Run `pnpm run build:native` in `node/` first.
//
//   node scripts/write-footprint.mjs          # measure and write app/data/footprint.json
//   node scripts/write-footprint.mjs --check  # verify the committed record
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFerrikiPlatformTarget } from "../../node/ferriki/platforms.mjs";

const artifact = new URL("../app/data/footprint.json", import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../node/ferriki/", import.meta.url));
const platform = "linux-x64-gnu";
// The files the measured addon and package are built from.
const sources = [
  "Cargo.toml",
  "Cargo.lock",
  "build.rs",
  "src",
  "crates",
  "assets/shiki",
  "node/ferriki",
];

// The footprint page states this; node/scripts/check-native-boundary.mjs
// additionally rejects OXC in the addon's and the crate's dependency trees.
const parserCrates = [
  ...readFileSync(new URL("../../Cargo.lock", import.meta.url), "utf8").matchAll(
    /^name = "((?:oxc|swc|boa)[_-][^"]*)"$/gm,
  ),
].map((match) => match[1]);
assert.deepEqual(parserCrates, [], "Cargo.lock names a JavaScript toolchain crate");

if (process.argv.includes("--check")) {
  const record = JSON.parse(readFileSync(artifact, "utf8"));
  assert.match(record.measured, /^\d{4}-\d{2}-\d{2}$/, "measured must be a date");
  assert.match(record.revision, /^[\da-f]{8}$/, "revision must be a short commit hash");
  assert.equal(record.addon?.platform, platform, `the addon is measured on ${platform}`);
  assert.match(record.addon.toolchain, /^rustc \d+\.\d+\.\d+/, "the toolchain is recorded");
  for (const value of [
    record.addon.bytes,
    record.core?.packedBytes,
    record.core?.unpackedBytes,
    record.core?.files,
  ])
    assert(Number.isSafeInteger(value) && value > 0, "sizes and counts are positive integers");
  assert(record.core.packedBytes < record.core.unpackedBytes, "the tarball is compressed");
  console.log(
    `The committed footprint record is well-formed (${record.measured}, ${record.revision}).`,
  );
} else {
  assert.equal(
    resolveFerrikiPlatformTarget()?.id,
    platform,
    `Measure the addon on ${platform}, the platform the footprint page names.`,
  );
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  assert.equal(
    git("status", "--porcelain", "--", ...sources),
    "",
    "Commit the sources before measuring: the record names the revision they come from.",
  );
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const [packed] = JSON.parse(
    execFileSync(npm, ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" },
    }),
  );
  const record = {
    measured: new Date().toISOString().slice(0, 10),
    revision: git("log", "-1", "--format=%h", "--abbrev=8", "--", ...sources),
    addon: {
      platform,
      bytes: statSync(join(packageRoot, "dist", "ferriki.node")).size,
      toolchain: execFileSync("rustc", ["--version"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    },
    core: {
      name: packed.name,
      packedBytes: packed.size,
      unpackedBytes: packed.unpackedSize,
      files: packed.files.length,
    },
  };
  writeFileSync(artifact, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote app/data/footprint.json (${record.addon.bytes} bytes addon on ${platform}).`);
}
