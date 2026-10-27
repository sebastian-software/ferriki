import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyPlatform } from "ferramenta-native/packages";
import config from "../native-npm.config.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const platformId = process.env.FERRIKI_PLATFORM_ID;
assert(platformId, "FERRIKI_PLATFORM_ID is required for a platform package check");

await verifyPlatform(config, platformId);

const packageDir = join(nodeRoot, "platforms", platformId);
const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const addon = join(packageDir, "ferriki.node");
const info = await stat(addon);
const npmCache = await mkdtemp(join(tmpdir(), "ferriki-sidecar-npm-"));

assert.equal(manifest.name, `@ferriki/${platformId}`);
assert(manifest.files.includes("ferriki.node"), `${manifest.name} must publish ferriki.node`);
for (const licenseFile of ["LICENSE-APACHE", "LICENSE-MIT"])
  assert(manifest.files.includes(licenseFile), `${manifest.name} must publish ${licenseFile}`);
assert(
  info.size > 100_000,
  `${manifest.name} native addon is unexpectedly small (${info.size} bytes)`,
);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(npm, ["pack", "--dry-run", "--json"], {
  cwd: packageDir,
  encoding: "utf8",
  env: {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
  },
  shell: process.platform === "win32",
  stdio: "pipe",
});
if (packed.status !== 0) {
  await rm(npmCache, { recursive: true, force: true });
  throw new Error(`${npm} pack failed for ${manifest.name}:\n${packed.stderr}`);
}

const packResult = JSON.parse(packed.stdout);
const archive = Array.isArray(packResult) ? packResult[0] : packResult[manifest.name];
assert.equal(archive?.name, manifest.name, "npm pack must describe the expected platform package");
const files = archive.files.map((file) => file.path);
assert(files.includes("ferriki.node"), `${manifest.name} dry-run package is missing ferriki.node`);
// The dual license is only real if both texts travel with the published addon.
for (const licenseFile of ["LICENSE-APACHE", "LICENSE-MIT"])
  assert(files.includes(licenseFile), `${manifest.name} dry-run package is missing ${licenseFile}`);
await rm(npmCache, { recursive: true, force: true });
console.log(`Ferriki platform package verified (${manifest.name}, ${info.size} bytes)`);
