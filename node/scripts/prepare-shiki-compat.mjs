import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const nodeRoot = path.resolve(scriptDir, "..");
const mirrorRoot = path.join(nodeRoot, "compat/upstream/shiki");
const checkScript = path.join(scriptDir, "check-shiki-compat-clean.mjs");
const manifestCheckScript = path.join(scriptDir, "check-shiki-compat-manifest.mjs");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) process.exit(result.status || 1);
}

function packagePath(name) {
  return path.join(mirrorRoot, "packages", name);
}

async function prepareIn(directory) {
  run(
    process.execPath,
    ["--import", "tsx/esm", path.join(directory, "scripts/prepare.ts")],
    directory,
  );
}

async function copyPackage(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter(sourcePath) {
      const relative = path.relative(source, sourcePath);
      return (
        relative !== "node_modules" &&
        relative !== "dist" &&
        !relative.startsWith(`node_modules${path.sep}`) &&
        !relative.startsWith(`dist${path.sep}`)
      );
    },
  });
}

async function main() {
  run(process.execPath, [manifestCheckScript], nodeRoot);
  run(process.execPath, [checkScript], nodeRoot);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ferriki-shiki-"));
  try {
    const tempPackages = path.join(tempRoot, "packages");
    await mkdir(tempPackages, { recursive: true });
    await symlink(path.join(nodeRoot, "node_modules"), path.join(tempRoot, "node_modules"));

    const tempLangs = path.join(tempPackages, "langs");
    const tempThemes = path.join(tempPackages, "themes");
    const tempShiki = path.join(tempPackages, "shiki");
    await copyPackage(packagePath("langs"), tempLangs);
    await copyPackage(packagePath("themes"), tempThemes);
    await copyPackage(packagePath("shiki"), tempShiki);

    // The upstream generators intentionally rewrite package.json and Shiki's
    // bundle indexes. Run them in a throw-away checkout and keep only dist/.
    await symlink(
      path.join(packagePath("langs"), "node_modules"),
      path.join(tempLangs, "node_modules"),
    );
    await symlink(
      path.join(packagePath("themes"), "node_modules"),
      path.join(tempThemes, "node_modules"),
    );
    await prepareIn(tempLangs);
    await prepareIn(tempThemes);

    await rm(path.join(packagePath("langs"), "dist"), { recursive: true, force: true });
    await rm(path.join(packagePath("themes"), "dist"), { recursive: true, force: true });
    await cp(path.join(tempLangs, "dist"), path.join(packagePath("langs"), "dist"), {
      recursive: true,
    });
    await cp(path.join(tempThemes, "dist"), path.join(packagePath("themes"), "dist"), {
      recursive: true,
    });

    // These generators only write ignored files in the real mirror and are
    // needed by the package builds and compatibility tests.
    await prepareIn(packagePath("shiki"));
    await prepareIn(packagePath("colorized-brackets"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  run(process.execPath, [checkScript], nodeRoot);
  run(process.execPath, [manifestCheckScript], nodeRoot);
}

main().catch((error) => {
  console.error(`[prepare-shiki-compat] ${error.stack || error}`);
  process.exit(1);
});
