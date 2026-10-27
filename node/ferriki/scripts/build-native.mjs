import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildArguments, runBuild, stageAddon } from "ferramenta-native/build";
import { targetForTriple } from "ferramenta-native/targets";

import config from "../../native-npm.config.mjs";
import { resolveFerrikiPlatformTarget } from "../platforms.mjs";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgDir, "..", "..");
const manifestPath = join(repoRoot, "crates", "ferriki-core", "Cargo.toml");
const addonOut = join(pkgDir, "ferriki.node");
const distAddonOut = join(pkgDir, "dist", "ferriki.node");
const rustTarget = process.env.FERRIKI_RUST_TARGET;
let platformTarget = process.env.FERRIKI_PLATFORM_TARGET;
let platformId = process.env.FERRIKI_PLATFORM_ID;

if (rustTarget) platformId = targetForTriple(rustTarget).id;
if (!platformId) platformId = resolveFerrikiPlatformTarget()?.id;
if (!platformId) throw new Error("Unsupported host platform");
platformTarget ??= platformId.replace(/-gnu$|-msvc$/g, "");

const platformAddonOut = join(pkgDir, "dist", `ferriki.${platformTarget}.node`);
const sidecarAddonOut = platformId
  ? join(repoRoot, "node", "platforms", platformId, "ferriki.node")
  : undefined;
const syncAssetsScript = join(pkgDir, "scripts", "sync-standard-assets.mjs");
// musl targets are cross-compiled from a glibc host with cargo-zigbuild, the
// same toolchain Ferromark uses. A Node addon is a shared library, so the musl
// CRT must be linked dynamically: Rust links it statically by default, which
// rules out a loadable cdylib.
const materialize = spawnSync(
  process.execPath,
  [join(repoRoot, "scripts/materialize-assets.mjs"), "--payloads"],
  { cwd: repoRoot, stdio: "inherit" },
);
if (materialize.status !== 0) process.exit(materialize.status ?? 1);
const notices = spawnSync(process.execPath, [join(repoRoot, "scripts/write-grammar-notices.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (notices.status !== 0) process.exit(notices.status ?? 1);
const cargoConfig = process.env.FERRIKI_FERRONI_PATH
  ? [
      "--config",
      `patch.crates-io.ferroni.path=${JSON.stringify(resolve(process.env.FERRIKI_FERRONI_PATH))}`,
    ]
  : [];
const cargoEnv = { ...process.env };
if (cargoConfig.length) {
  const update = spawnSync("cargo", ["update", "--offline", "-p", "ferroni", ...cargoConfig], {
    cwd: repoRoot,
    env: cargoEnv,
    stdio: "inherit",
  });
  if (update.error) throw update.error;
  if (update.status !== 0) process.exit(update.status ?? 1);
}
const outputDir = join(repoRoot, "target", "node-addon", rustTarget ?? "host");
const buildOptions = {
  cwd: pkgDir,
  manifestPath,
  profile: "release",
  outputDir,
  dts: "native-binding.d.ts",
  target: rustTarget,
  env: cargoEnv,
  cargoArgs: cargoConfig,
};
const cargoArgs = buildArguments(buildOptions);
runBuild(buildOptions);
const { input: selectedInput } = await stageAddon(config, {
  outputDir,
  dts: "native-binding.d.ts",
  target: rustTarget,
});
const formatTypes = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "oxfmt", "--write", join(pkgDir, "native-binding.d.ts")],
  { cwd: join(repoRoot, "node"), shell: process.platform === "win32", stdio: "inherit" },
);
if (formatTypes.error) throw formatTypes.error;
if (formatTypes.status !== 0) process.exit(formatTypes.status ?? 1);
await mkdir(join(pkgDir, "dist"), { recursive: true });
for (const destination of [addonOut, distAddonOut, platformAddonOut])
  await cp(selectedInput, destination);
const syncAssets = spawnSync(process.execPath, [syncAssetsScript], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (syncAssets.error) throw syncAssets.error;
if (syncAssets.status !== 0) process.exit(syncAssets.status ?? 1);

function command(program, args, cwd = repoRoot) {
  const result = spawnSync(program, args, { cwd, env: cargoEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${program} failed`);
  return result.stdout.trim();
}

const metadata = JSON.parse(
  // Metadata resolves workspace/dev and foreign-target dependencies too. A
  // successful target build does not guarantee those crates are cached.
  command("cargo", ["metadata", "--locked", "--format-version", "1", ...cargoConfig]),
);

// Bind benchmark provenance to the binary actually built, rather than inferring
// its Ferroni version from a lockfile that could have changed since the build.
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
  cargoProfileEnv: Object.fromEntries(
    Object.entries(cargoEnv).filter(([key]) => key.startsWith("CARGO_PROFILE_")),
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
