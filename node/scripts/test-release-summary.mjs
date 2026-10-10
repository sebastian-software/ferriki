import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FERRIKI_PLATFORM_TARGETS } from "../ferriki/platforms.mjs";
import { formatReleaseSummary, readSidecarAddonSizes } from "./write-release-summary.mjs";

const script = fileURLToPath(new URL("./write-release-summary.mjs", import.meta.url));
const published = {
  RELEASES_CREATED: "true",
  RELEASE_RESULT: "success",
  SOURCE_RESULT: "success",
  BUILD_RESULT: "success",
  PUBLISH_RESULT: "success",
  VERIFY_RESULT: "success",
};
const outcome = [
  "## Ferriki release outcome: PUBLISHED",
  "",
  "- npm dist-tag: `latest`",
  "- release-please: `success` (releases created: `true`)",
  "- exact release source and CI gate: `success`",
  "- native build matrix: `success`",
  "- npm publication: `success`",
  "- public registry/install verification: `success`",
];

// Without sizes the summary keeps its established lines.
assert.deepEqual(formatReleaseSummary(published), {
  state: "PUBLISHED",
  summary: `${outcome.join("\n")}\n`,
});
assert.equal(formatReleaseSummary({ ...published, SOURCE_RESULT: "failure", BUILD_RESULT: "skipped", PUBLISH_RESULT: "skipped" }).state, "FAILED");

const fixtureRoot = await mkdtemp(join(tmpdir(), "ferriki-release-summary-"));
try {
  // Artifact downloads use one `native-<platform id>` directory per target.
  for (const [id, bytes] of [
    ["linux-x64-gnu", 2_775_072],
    ["win32-x64-msvc", 1_000],
  ]) {
    await mkdir(join(fixtureRoot, `native-${id}`));
    await writeFile(join(fixtureRoot, `native-${id}`, "ferriki.node"), Buffer.alloc(bytes));
  }

  const sizes = await readSidecarAddonSizes(fixtureRoot);
  assert.deepEqual(
    sizes.map(({ id }) => id),
    FERRIKI_PLATFORM_TARGETS.map(({ id }) => id),
    "every published target is listed in registry order",
  );
  const sizeRows = [
    "",
    "### Native addon sizes",
    "",
    "| Target | Unpacked `ferriki.node` |",
    "| --- | ---: |",
    "| `linux-x64-gnu` | 2,775,072 bytes (2.78 MB) |",
    "| `linux-arm64-gnu` | missing |",
    "| `linux-x64-musl` | missing |",
    "| `linux-arm64-musl` | missing |",
    "| `darwin-arm64` | missing |",
    "| `win32-x64-msvc` | 1,000 bytes (0.00 MB) |",
    "| `win32-arm64-msvc` | missing |",
  ];
  assert.equal(
    formatReleaseSummary(published, sizes).summary,
    `${[...outcome, ...sizeRows].join("\n")}\n`,
  );

  // The workflow step reads the downloaded artifacts only when the build ran.
  const run = (env) => {
    const stepSummary = join(fixtureRoot, `summary-${env.BUILD_RESULT}.md`);
    execFileSync(process.execPath, [script], {
      cwd: fixtureRoot,
      env: { ...published, ...env, GITHUB_STEP_SUMMARY: stepSummary, NATIVE_SIDECARS_DIR: "." },
      stdio: "pipe",
    });
    return readFile(stepSummary, "utf8");
  };
  assert.equal(await run({}), `${[...outcome, ...sizeRows].join("\n")}\n`);
  assert.doesNotMatch(
    await run({ RELEASES_CREATED: "false", BUILD_RESULT: "skipped" }),
    /Native addon sizes/,
    "a run without native builds must not report every addon as missing",
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("Ferriki release summary verified");
