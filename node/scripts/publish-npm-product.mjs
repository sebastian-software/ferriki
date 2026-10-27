import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { publishWithNpm as publishNativePackage } from "ferramenta-native";
import { createNpmPublisher } from "ferramenta-native/publish";

import { FERRIKI_PLATFORM_TARGETS } from "../ferriki/platforms.mjs";
export function publishWithNpm(pkg, tag, _phase, options) {
  return publishNativePackage(pkg, tag, options);
}

const REPOSITORY = "https://github.com/sebastian-software/ferriki";
const WORKFLOW = ".github/workflows/publish.yml";
const publisher = createNpmPublisher({ repository: REPOSITORY, workflow: WORKFLOW });
export const {
  attestationUrl,
  distTagsUrl,
  verifyExistingPackage,
  lookupPackage,
  lookupDistTag,
  publishPhase,
} = publisher;

export async function readReleasePackages(root = fileURLToPath(new URL("..", import.meta.url))) {
  const core = JSON.parse(await readFile(join(root, "ferriki", "package.json"), "utf8"));
  const vite = JSON.parse(await readFile(join(root, "vite", "package.json"), "utf8"));
  assert.equal(core.name, "@ferriki/core");
  assert.equal(vite.name, "@ferriki/vite");
  assert.equal(vite.version, core.version);
  assert.equal(vite.dependencies?.[core.name], core.version);
  const sidecars = [];
  for (const target of FERRIKI_PLATFORM_TARGETS) {
    const path = join(root, "platforms", target.id);
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    assert.equal(manifest.name, target.packageName);
    assert.equal(manifest.version, core.version);
    assert.equal(core.optionalDependencies?.[manifest.name], core.version);
    sidecars.push({ name: manifest.name, version: core.version, path });
  }
  return {
    sidecars,
    core: [{ name: core.name, version: core.version, path: join(root, "ferriki") }],
    vite: [{ name: vite.name, version: core.version, path: join(root, "vite") }],
  };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const phase = process.argv[2];
    if (!["sidecars", "core", "vite"].includes(phase))
      throw new Error("expected sidecars, core, or vite phase");
    const all = await readReleasePackages();
    const sourceSha = process.env.FERRIKI_RELEASE_SHA;
    if (sourceSha !== process.env.GITHUB_SHA)
      throw new Error("workflow run SHA differs from the immutable release source");
    if (all.core[0].version !== process.env.FERRIKI_RELEASE_VERSION)
      throw new Error("checked-out package version differs from the verified release version");
    await publishPhase({
      packages: all[phase],
      phase,
      sourceSha,
      releaseTag: process.env.FERRIKI_RELEASE_TAG,
      tag: process.env.NPM_DIST_TAG,
      recovery: process.env.FERRIKI_RECOVERY === "true",
      publishImpl: publishWithNpm,
      promoteImpl: async (pkg, distTag) =>
        run("npm", ["dist-tag", "add", `${pkg.name}@${pkg.version}`, distTag], pkg.path),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
