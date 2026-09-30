import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveFerrikiPlatformTarget } from "../platforms.mjs";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgDir, "..", "..");
const manifestPath = join(repoRoot, "crates", "ferriki-core", "Cargo.toml");
const addonOut = join(pkgDir, "ferriki.node");
const distAddonOut = join(pkgDir, "dist", "ferriki.node");
const rustTarget = process.env.FERRIKI_RUST_TARGET;
let platformTarget = process.env.FERRIKI_PLATFORM_TARGET;
let platformId = process.env.FERRIKI_PLATFORM_ID;

if (!platformId && rustTarget) {
  platformId = {
    "x86_64-unknown-linux-gnu": "linux-x64-gnu",
    "aarch64-unknown-linux-gnu": "linux-arm64-gnu",
    "x86_64-unknown-linux-musl": "linux-x64-musl",
    "aarch64-unknown-linux-musl": "linux-arm64-musl",
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-pc-windows-msvc": "win32-x64-msvc",
    "aarch64-pc-windows-msvc": "win32-arm64-msvc",
  }[rustTarget];
}

// A host build without an explicit target also fills the host's platform
// package: packed installs load the addon only from there.
if (!platformId && !rustTarget) platformId = resolveFerrikiPlatformTarget()?.id;

if (!platformTarget && rustTarget) {
  platformTarget = {
    "x86_64-unknown-linux-gnu": "linux-x64",
    "aarch64-unknown-linux-gnu": "linux-arm64",
    "x86_64-unknown-linux-musl": "linux-x64-musl",
    "aarch64-unknown-linux-musl": "linux-arm64-musl",
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-pc-windows-msvc": "win32-x64",
    "aarch64-pc-windows-msvc": "win32-arm64",
  }[rustTarget];
}

if (!platformTarget) platformTarget = `${process.platform}-${process.arch}`;

if (!platformTarget) {
  throw new Error(`[ferriki] Unsupported FERRIKI_RUST_TARGET: ${rustTarget}`);
}

const platformAddonOut = join(pkgDir, "dist", `ferriki.${platformTarget}.node`);
const sidecarAddonOut = platformId
  ? join(repoRoot, "node", "platforms", platformId, "ferriki.node")
  : undefined;
const syncAssetsScript = join(pkgDir, "scripts", "sync-standard-assets.mjs");
// musl targets are cross-compiled from a glibc host with cargo-zigbuild, the
// same toolchain Ferromark uses. A Node addon is a shared library, so the musl
// CRT must be linked dynamically: Rust links it statically by default, which
// rules out a loadable cdylib.
const isMusl = rustTarget?.endsWith("-musl") ?? false;
const cargoArgs = [isMusl ? "zigbuild" : "build", "--release", "--manifest-path", manifestPath];
// Benchmark one local Ferroni experiment without changing workspace dependencies.
const cargoConfig = process.env.FERRIKI_FERRONI_PATH
  ? [
      "--config",
      `patch.crates-io.ferroni.path=${JSON.stringify(resolve(process.env.FERRIKI_FERRONI_PATH))}`,
    ]
  : [];
cargoArgs.push(...cargoConfig);

if (rustTarget) cargoArgs.push("--target", rustTarget);

const cargoEnv = { ...process.env };
if (isMusl) {
  const rustflagsVar = `CARGO_TARGET_${rustTarget.toUpperCase().replaceAll("-", "_")}_RUSTFLAGS`;
  cargoEnv[rustflagsVar] = [cargoEnv[rustflagsVar], "-C target-feature=-crt-static"]
    .filter(Boolean)
    .join(" ");
}

if (cargoConfig.length) {
  // A lockfile can keep the registry version and silently leave a patch unused.
  const update = spawnSync("cargo", ["update", "--offline", "-p", "ferroni", ...cargoConfig], {
    cwd: repoRoot,
    env: cargoEnv,
    stdio: "inherit",
  });
  if (update.status !== 0) process.exit(update.status ?? 1);
}

const cargo = spawnSync("cargo", cargoArgs, {
  cwd: repoRoot,
  env: cargoEnv,
  stdio: "inherit",
});

if (cargo.status !== 0) process.exit(cargo.status ?? 1);

const dylibName =
  process.platform === "darwin"
    ? "libferriki_core.dylib"
    : process.platform === "linux"
      ? "libferriki_core.so"
      : "ferriki_core.dll";

const candidates = [
  join(repoRoot, "target", ...(rustTarget ? [rustTarget] : []), "release", dylibName),
];

let selectedInput = null;
for (const candidate of candidates) {
  try {
    const info = await stat(candidate);
    if (info.isFile()) {
      selectedInput = candidate;
      break;
    }
  } catch (error) {
    void error;
  }
}

if (!selectedInput) {
  throw new Error(
    [
      "[ferriki] Could not locate compiled native artifact.",
      "Expected one of:",
      ...candidates.map((i) => `- ${i}`),
    ].join("\n"),
  );
}

await cp(selectedInput, addonOut);
await cp(selectedInput, distAddonOut);
await cp(selectedInput, platformAddonOut);
if (sidecarAddonOut) await cp(selectedInput, sidecarAddonOut);
const syncAssets = spawnSync("node", [syncAssetsScript], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (syncAssets.status !== 0) process.exit(syncAssets.status ?? 1);

// Bind benchmark provenance to the binary actually built, rather than inferring
// its Ferroni version from a lockfile that could have changed since the build.
function command(program, args, cwd = repoRoot) {
  const result = spawnSync(program, args, { cwd, env: cargoEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${program} failed`);
  return result.stdout.trim();
}
function revision(directory) {
  try {
    return {
      commit: command("git", ["rev-parse", "HEAD"], directory),
      status: command("git", ["status", "--porcelain"], directory),
    };
  } catch {
    return null;
  }
}
async function sourceFingerprint(directory) {
  let listing;
  try {
    listing = command(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "*.rs",
        "Cargo.toml",
        "**/Cargo.toml",
      ],
      directory,
    );
  } catch {
    // Source archives can still build; revision comparisons require Git.
    return null;
  }
  const files = listing.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(directory, file)));
  return hash.digest("hex");
}
const metadata = JSON.parse(
  command("cargo", ["metadata", "--offline", "--format-version", "1", ...cargoConfig]),
);
const ferroni = metadata.packages.find((pkg) => pkg.name === "ferroni");
if (!ferroni) throw new Error("Ferroni was not resolved in the native build");
if (cargoConfig.length && ferroni.source)
  throw new Error("The requested local Ferroni patch was not used");
const receipt = {
  builtAt: new Date().toISOString(),
  binarySha256: createHash("sha256")
    .update(await readFile(selectedInput))
    .digest("hex"),
  ferriki: revision(repoRoot),
  rustSourceSha256: await sourceFingerprint(repoRoot),
  ferroni: {
    version: ferroni.version,
    source: ferroni.source,
    manifestPath: ferroni.manifest_path,
    revision: ferroni.source ? null : revision(dirname(ferroni.manifest_path)),
    sourceSha256: ferroni.source ? null : await sourceFingerprint(dirname(ferroni.manifest_path)),
    features: metadata.resolve.nodes.find((node) => node.id === ferroni.id).features,
  },
  rustc: command("rustc", ["--version", "--verbose"]),
  cargoArgs,
  rustflags: cargoEnv.RUSTFLAGS ?? null,
  encodedRustflags: cargoEnv.CARGO_ENCODED_RUSTFLAGS ?? null,
  targetRustflags: Object.fromEntries(
    Object.entries(cargoEnv).filter(([key]) => /^CARGO_TARGET_.*_RUSTFLAGS$/.test(key)),
  ),
  cargoLockSha256: createHash("sha256")
    .update(await readFile(join(repoRoot, "Cargo.lock")))
    .digest("hex"),
};
await writeFile(join(pkgDir, ".benchmark-build.json"), `${JSON.stringify(receipt, null, 2)}\n`);

console.log(`[ferriki] Native addon ready: ${addonOut}`);
console.log(`[ferriki] Workspace native addon ready: ${distAddonOut}`);
console.log(`[ferriki] Platform addon ready: ${platformAddonOut}`);
if (sidecarAddonOut) console.log(`[ferriki] Sidecar addon ready: ${sidecarAddonOut}`);
