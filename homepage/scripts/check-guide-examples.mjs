/* eslint-disable security/detect-non-literal-fs-filename -- Paths are rooted at this script or a temporary directory. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FERRIKI_PLATFORM_TARGETS,
  resolveFerrikiPlatformTarget,
} from "../../node/ferriki/platforms.mjs";

const homepageRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = join(homepageRoot, "..");
const nodeRoot = join(repoRoot, "node");
const packageRoot = join(nodeRoot, "ferriki");
const cacheDir = join(nodeRoot, ".cache", "ferriki-assets");
const platformId = process.env.FERRIKI_PLATFORM_ID ?? resolveFerrikiPlatformTarget()?.id;
assert(
  platformId,
  "FERRIKI_PLATFORM_ID is required on a platform Ferriki does not support natively",
);
const platform = FERRIKI_PLATFORM_TARGETS.find((target) => target.id === platformId);
assert(platform, `Unknown Ferriki platform id: ${platformId}`);

await stat(join(nodeRoot, "platforms", platformId, "ferriki.node")).catch(() => {
  throw new Error(
    `The ${platformId} native sidecar is missing. Run pnpm --dir node run build:native first.`,
  );
});
await stat(cacheDir).catch(() => {
  throw new Error("The local Ferriki asset cache is missing. Run build:native first.");
});

const expectedSamples = new Map([
  ["one-shot", "guide/getting-started.mdx"],
  ["reusable", "guide/getting-started.mdx"],
  ["catalogs", "guide/languages-and-themes.mdx"],
  ["theme-map", "guide/languages-and-themes.mdx"],
  ["class-output", "guide/class-highlighting.mdx"],
]);
const assertions = {
  "one-shot": `assert.match(html, /<pre\\b/);\nassert.match(html, /answer/);`,
  reusable: `assert.match(html, /<pre\\b/);\nassert.match(html, /answer/);`,
  catalogs: `assert.equal(bundledLanguagesAlias.ts, "typescript");\nassert.match(html, /<pre\\b/);\nassert.match(html, /answer/);`,
  "theme-map": `assert.match(html, /<pre\\b/);\nassert.match(html, /answer/);\nassert.match(html, /github-(light|dark)/);`,
  "class-output": `assert.match(html, /tok-string/);\nassert.match(css, /\\.ferriki/);`,
};
const samples = new Map();

for (const path of new Set(expectedSamples.values())) {
  const source = await readFile(join(homepageRoot, "app", "routes", path), "utf8");
  for (const block of fencedCodeBlocks(source)) {
    const marker = /(?:^|\s)ferriki-check=([a-z0-9-]+)(?=\s|$)/i.exec(block.info);
    if (!marker) continue;
    const name = marker[1];
    if (!expectedSamples.has(name)) continue;
    assert.equal(
      expectedSamples.get(name),
      path,
      `Sample ${name} is in an unexpected guide: ${path}`,
    );
    assert.equal(
      block.language.toLowerCase(),
      "js",
      `Executable sample ${name} must be plain JavaScript`,
    );
    assert(!samples.has(name), `Executable sample ${name} appears more than once`);
    samples.set(name, block.code.trimEnd());
  }
}

function* fencedCodeBlocks(source) {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const opening = parseFenceOpening(lines[index]);
    if (!opening) continue;
    const end = findFenceEnd(lines, index + 1);
    if (end === lines.length) continue;
    yield {
      language: opening.language,
      info: opening.info,
      code: lines.slice(index + 1, end).join("\n"),
    };
    index = end;
  }
}

function parseFenceOpening(line) {
  if (!line.startsWith("```")) return;
  const info = line.slice(3);
  const languageEnd = info.search(/\s/);
  const language = languageEnd === -1 ? info : info.slice(0, languageEnd);
  if (!/^[a-z][\w-]*$/i.test(language)) return;
  return { language, info: languageEnd === -1 ? "" : info.slice(languageEnd).trim() };
}

function findFenceEnd(lines, start) {
  for (let index = start; index < lines.length; index++) {
    if (/^```\s*$/.test(lines[index])) return index;
  }
  return lines.length;
}

assert.deepEqual(
  [...samples.keys()].sort(),
  [...expectedSamples.keys()].sort(),
  "Add one complete JavaScript fence for every ferriki-check sample listed in this script.",
);

const temporaryRoot = await mkdtemp(join(tmpdir(), "ferriki-guide-samples-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCache = join(temporaryRoot, "npm-cache");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    env: {
      ...process.env,
      FERRIKI_ASSETS_REMOTE: "0",
      FERRIKI_CACHE_DIR: cacheDir,
      npm_config_cache: npmCache,
      npm_config_update_notifier: "false",
      npm_config_offline: "true",
      ...options.env,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.error ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

try {
  const core = JSON.parse(
    run(npm, ["pack", "--json", "--pack-destination", temporaryRoot]).stdout,
  )[0];
  const sidecar = JSON.parse(
    run(npm, ["pack", "--json", "--pack-destination", temporaryRoot], {
      cwd: join(nodeRoot, "platforms", platformId),
    }).stdout,
  )[0];
  assert.equal(
    sidecar.name,
    platform.packageName,
    "Packed sidecar does not match the host platform",
  );
  assert.equal(sidecar.version, core.version, "Core package and native sidecar versions differ");

  const consumer = join(temporaryRoot, "consumer");
  await mkdir(consumer);
  run(npm, ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
  run(
    npm,
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temporaryRoot, core.filename),
      join(temporaryRoot, sidecar.filename),
    ],
    { cwd: consumer, stdio: "ignore" },
  );

  for (const [name, code] of samples) {
    const file = join(consumer, `guide-${name}.mjs`);
    await writeFile(
      file,
      `import assert from "node:assert/strict";\n${code}\n\n${assertions[name]}\n`,
    );
    run(process.execPath, [file], { cwd: consumer });
    console.log(`Executed guide sample: ${name}`);
  }

  console.log(
    `Verified ${samples.size} guide samples against packed @ferriki/core@${core.version} and ${sidecar.name}@${sidecar.version} (${platformId}).`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
