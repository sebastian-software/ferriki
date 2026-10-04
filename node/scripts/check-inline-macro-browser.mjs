import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FERRIKI_PLATFORM_TARGETS, resolveFerrikiPlatformTarget } from "../ferriki/platforms.mjs";
import "./test-asset-env.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const coreRoot = join(nodeRoot, "ferriki");
const viteRoot = join(nodeRoot, "vite");
const fixtureRoot = join(nodeRoot, "examples", "inline-macro");
// The current Vite 8 release; the packed consumer check also covers the 8.0.0 floor.
const viteVersion = "8.3.2";
const platformId = process.env.FERRIKI_PLATFORM_ID ?? resolveFerrikiPlatformTarget()?.id;
assert(platformId, "FERRIKI_PLATFORM_ID is required on an unsupported native target");
const target = FERRIKI_PLATFORM_TARGETS.find((entry) => entry.id === platformId);
assert(target, `unknown Ferriki platform id ${platformId}`);
const sidecarRoot = join(nodeRoot, "platforms", platformId);
await stat(join(sidecarRoot, "ferriki.node")).catch(() => {
  throw new Error(
    `build the ${platformId} sidecar before running the packed inline macro browser check`,
  );
});

const tempRoot = await mkdtemp(join(tmpdir(), "ferriki-inline-macro-browser-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cacheDir = join(tempRoot, "npm-cache");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? nodeRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" && (command === "npm.cmd" || command === "pnpm.cmd"),
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
      npm_config_update_notifier: "false",
      ...options.env,
    },
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.error ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  return result;
}

function npmPack(directory) {
  const result = run(npm, ["pack", "--json", "--pack-destination", tempRoot], { cwd: directory });
  return JSON.parse(result.stdout)[0];
}

try {
  const vitePack = run(pnpm, ["pack", "--pack-destination", tempRoot], { cwd: viteRoot });
  const viteTarball = vitePack.stdout.trim().split("\n").at(-1);
  assert(
    viteTarball.endsWith(".tgz"),
    `pnpm pack did not return a Vite tarball: ${vitePack.stdout}`,
  );
  const viteTarballPath = viteTarball.startsWith(tempRoot)
    ? viteTarball
    : join(tempRoot, viteTarball);
  const vitePackage = JSON.parse(await readFile(join(viteRoot, "package.json"), "utf8"));
  const fixturePackage = JSON.parse(await readFile(join(fixtureRoot, "package.json"), "utf8"));
  const corePack = npmPack(coreRoot);
  const sidecarPack = npmPack(sidecarRoot);
  const coreTarball = join(tempRoot, corePack.filename);
  const sidecarTarball = join(tempRoot, sidecarPack.filename);

  const consumer = join(tempRoot, "consumer");
  const projectPath = join(consumer, "app");
  const cacheWarm = join(tempRoot, "cache-warm");
  await Promise.all([
    mkdir(projectPath, { recursive: true }),
    mkdir(cacheWarm, { recursive: true }),
  ]);
  const project = await realpath(projectPath);
  await realpath(cacheWarm);
  run(npm, ["init", "--yes"], { cwd: cacheWarm, stdio: "ignore" });
  run(
    npm,
    [
      "install",
      "--no-audit",
      "--no-fund",
      `vite@${viteVersion}`,
      "magic-string@0.30.21",
      ...Object.entries(fixturePackage.devDependencies).map(
        ([name, version]) => `${name}@${version}`,
      ),
    ],
    { cwd: cacheWarm },
  );
  run(npm, ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
  run(
    npm,
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `vite@${viteVersion}`,
      ...Object.entries(fixturePackage.devDependencies).map(
        ([name, version]) => `${name}@${version}`,
      ),
      coreTarball,
      sidecarTarball,
      viteTarballPath,
    ],
    { cwd: consumer },
  );

  await cp(fixtureRoot, project, { recursive: true });
  const probe = join(consumer, "probe.mjs");
  await writeFile(probe, await readFile(join(fixtureRoot, "test", "browser-probe.mjs"), "utf8"));
  run(process.execPath, [probe], {
    cwd: consumer,
    env: { FERRIKI_PLATFORM_ID: platformId, FERRIKI_CONSUMER_PROJECT: project },
  });
  console.log(`Packed @ferriki/vite@${vitePackage.version} inline macro browser consumer passed`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
