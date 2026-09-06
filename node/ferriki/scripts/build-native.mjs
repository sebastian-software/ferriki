import { spawnSync } from "node:child_process";
import { cp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-apple-darwin": "darwin-x64",
    "x86_64-pc-windows-msvc": "win32-x64-msvc",
  }[rustTarget];
}

if (!platformTarget && rustTarget) {
  platformTarget = {
    "x86_64-unknown-linux-gnu": "linux-x64",
    "aarch64-unknown-linux-gnu": "linux-arm64",
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-apple-darwin": "darwin-x64",
    "x86_64-pc-windows-msvc": "win32-x64",
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
const cargoArgs = ["build", "--release", "--manifest-path", manifestPath];

if (rustTarget) cargoArgs.push("--target", rustTarget);

const cargo = spawnSync("cargo", cargoArgs, {
  cwd: repoRoot,
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

console.log(`[ferriki] Native addon ready: ${addonOut}`);
console.log(`[ferriki] Bundled native addon ready: ${distAddonOut}`);
console.log(`[ferriki] Platform addon ready: ${platformAddonOut}`);
if (sidecarAddonOut) console.log(`[ferriki] Sidecar addon ready: ${sidecarAddonOut}`);
