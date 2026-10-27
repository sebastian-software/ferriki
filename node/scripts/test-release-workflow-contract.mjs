import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertReleaseWorkflow } from "./check-release-workflow.mjs";

const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = join(nodeRoot, "..");
const workflowPath = join(repoRoot, ".github", "workflows", "publish.yml");
const workflow = await readFile(workflowPath, "utf8");
const checklist = await readFile(join(repoRoot, "docs", "release-checklist.md"), "utf8");
const releaseConfig = JSON.parse(
  await readFile(join(repoRoot, ".release-please-config.json"), "utf8"),
);
const nodePackage = JSON.parse(await readFile(join(nodeRoot, "package.json"), "utf8"));

assert.doesNotThrow(() =>
  assertReleaseWorkflow({ workflow, checklist, releaseConfig, nodePackage }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(/ {6}- verify-release-source\n(?= {4}if:)/, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /publish-crates must depend on exact-release verification/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        /ref: \$\{\{ needs\.verify-release-source\.outputs\.release_sha \}\}/,
        "ref: github.sha",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /publish-crates must check out the verified release SHA/,
);
assert.doesNotThrow(() =>
  assertReleaseWorkflow({
    workflow,
    checklist,
    releaseConfig,
    nodePackage: { ...nodePackage, packageManager: "pnpm@10.29.0" },
  }),
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow,
      checklist,
      releaseConfig,
      nodePackage: { ...nodePackage, packageManager: "pnpm@11.0.0" },
    }),
  /workspace must use pnpm 10/,
);

assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        "run: node scripts/rebuild-locked-assets.mjs",
        "run: node --version",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /asset rebuild must verify the reviewed lock before upload/,
);

const concurrencyGroup = `  group: publish-\${{ github.repository }}\n`;
assert.equal(workflow.split(concurrencyGroup).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        concurrencyGroup,
        `  group: publish-\${{ github.repository }}-\${{ github.ref }}\n`,
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /one non-canceling concurrency group/,
);

const nativeAction = "        uses: ./node/node_modules/ferramenta-native/actions/release-native\n";
assert.equal(workflow.split(nativeAction).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(nativeAction, "        run: npm publish\n"),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must use the shared native release action/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace('          publish: "true"', '          publish: "false"'),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /enable publication explicitly/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace("            pnpm run check:packed-vite\n", ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /packed Vite consumer check/,
);

const withoutViteReleaseFiles = {
  ...releaseConfig,
  packages: {
    ".": {
      ...releaseConfig.packages["."],
      "extra-files": releaseConfig.packages["."]["extra-files"].filter(
        (file) => file.path !== "/node/vite/package.json",
      ),
    },
  },
};
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow,
      checklist,
      releaseConfig: withoutViteReleaseFiles,
      nodePackage,
    }),
  /must update the Vite integration version/,
);

for (const crate of ["ferriki-textmate", "ferriki-asset-gen"]) {
  const requiredSelector = `$.package[?(@.name.value=='${crate}' && !@.source)].version`;
  const withoutCrateLockEntry = {
    ...releaseConfig,
    packages: {
      ".": {
        ...releaseConfig.packages["."],
        "extra-files": releaseConfig.packages["."]["extra-files"].filter(
          (file) => file.jsonpath !== requiredSelector,
        ),
      },
    },
  };
  assert.throws(
    () =>
      assertReleaseWorkflow({
        workflow,
        checklist,
        releaseConfig: withoutCrateLockEntry,
        nodePackage,
      }),
    new RegExp(`must update ${crate} in the separate fuzz lockfile`),
  );
}

const broadFuzzLockSelector = {
  ...releaseConfig,
  packages: {
    ".": {
      ...releaseConfig.packages["."],
      "extra-files": releaseConfig.packages["."]["extra-files"].map((file) =>
        file.jsonpath === "$.package[?(@.name.value=='ferriki-textmate' && !@.source)].version"
          ? { ...file, jsonpath: "$.package[?(@.name.value=='ferriki-textmate')].version" }
          : file,
      ),
    },
  },
};
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow,
      checklist,
      releaseConfig: broadFuzzLockSelector,
      nodePackage,
    }),
  /must update ferriki-textmate in the separate fuzz lockfile/,
);

const crateOrder =
  "          crates: |\n" +
  "            ferriki-textmate\n" +
  "            ferriki-asset-gen\n" +
  "            ferriki\n";
assert.equal(workflow.split(crateOrder).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(
        crateOrder,
        "          crates: |\n" +
          "            ferriki\n" +
          "            ferriki-textmate\n" +
          "            ferriki-asset-gen\n",
      ),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /dependency order/,
);

const sidecarDownload = "          pattern: native-*\n          path: native-sidecars\n";
const sidecarSizeEnv = "          NATIVE_SIDECARS_DIR: native-sidecars\n";
assert.equal(workflow.split(sidecarDownload).length - 1, 1);
assert.equal(workflow.split(sidecarSizeEnv).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(sidecarDownload, "          name: native-linux-x64-gnu\n"),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release-summary must download every native sidecar artifact/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(sidecarSizeEnv, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /release-summary must report addon sizes/,
);

const cratesDependency = "      - verify-crates-publish\n";
const cratesResult = `          CRATES_RESULT: \${{ needs.publish-crates.result }}\n`;
assert.equal(workflow.split(cratesDependency).length - 1, 1);
assert.equal(workflow.split(cratesResult).length - 1, 1);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(cratesDependency, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /summary must wait for Rust verification/,
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflow.replace(cratesResult, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /CRATES_RESULT/,
);
const cratesGateGuard = "needs.verify-release-source.result == 'success' && ";
const cratesJobIndex = workflow.indexOf("\n  verify-crates-publish:\n");
assert(cratesJobIndex >= 0);
assert(workflow.slice(cratesJobIndex).includes(cratesGateGuard));
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow:
        workflow.slice(0, cratesJobIndex) +
        workflow.slice(cratesJobIndex).replace(cratesGateGuard, ""),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /crates verification must not check out an unverified release source/,
);

const fixtureRoot = await mkdtemp(join(tmpdir(), "ferriki-publish-contract-"));
const fixturePackage = join(fixtureRoot, "fixture");
const fixturePack = join(fixtureRoot, "packed");
const fixtureManifest = {
  name: "@ferriki/publish-contract-fixture",
  version: "0.0.0-test.0",
  files: ["package.json"],
  dependencies: { "magic-string": "catalog:integrations" },
};
try {
  await mkdir(fixturePackage, { recursive: true });
  await mkdir(fixturePack);
  await writeFile(
    join(fixtureRoot, "package.json"),
    JSON.stringify({ private: true, packageManager: nodePackage.packageManager }),
  );
  await writeFile(
    join(fixtureRoot, "pnpm-workspace.yaml"),
    "packages:\n  - fixture\ncatalogs:\n  integrations:\n    magic-string: ^0.30.21\n",
  );
  await writeFile(join(fixturePackage, "package.json"), JSON.stringify(fixtureManifest));

  const packResult = JSON.parse(
    execFileSync(
      "pnpm",
      ["--dir", fixturePackage, "pack", "--pack-destination", fixturePack, "--json"],
      { cwd: fixtureRoot, encoding: "utf8" },
    ),
  );
  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOf", packResult.filename, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(packedManifest.name, fixtureManifest.name);
  assert.equal(packedManifest.version, fixtureManifest.version);
  assert.deepEqual(packedManifest.dependencies, { "magic-string": "^0.30.21" });

  // The recovery publisher uses this exact pnpm JSON shape for every product
  // package, then passes the resulting tarball to npm.
  for (const [directory, expectedName] of [
    ["ferriki", "@ferriki/core"],
    ["platforms/linux-x64-gnu", "@ferriki/linux-x64-gnu"],
    ["vite", "@ferriki/vite"],
  ]) {
    const packageDirectory = join(nodeRoot, directory);
    const result = JSON.parse(
      execFileSync(
        "pnpm",
        ["--dir", packageDirectory, "pack", "--pack-destination", fixturePack, "--json"],
        { cwd: nodeRoot, encoding: "utf8" },
      ),
    );
    const sourceManifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    assert.equal(result.name, expectedName);
    assert.equal(result.version, sourceManifest.version);
    assert(result.filename.startsWith(`${fixturePack}/`));
    const productManifest = JSON.parse(
      execFileSync("tar", ["-xOf", result.filename, "package/package.json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(productManifest.name, expectedName);
    assert.equal(productManifest.version, sourceManifest.version);
    assert.doesNotMatch(JSON.stringify(productManifest), /\b(?:catalog|workspace):/);
  }

  const npmCache = join(fixtureRoot, "npm-cache");
  const npmUserConfig = join(fixtureRoot, "npmrc");
  const npmEnv = {
    ...process.env,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    npm_config_userconfig: npmUserConfig,
    NPM_CONFIG_OFFLINE: "true",
    npm_config_offline: "true",
    NPM_CONFIG_LOGLEVEL: "silent",
    npm_config_loglevel: "silent",
  };
  delete npmEnv.NODE_AUTH_TOKEN;
  const publishResult = JSON.parse(
    execFileSync(
      "npm",
      [
        "publish",
        packResult.filename,
        "--dry-run",
        "--json",
        "--access",
        "public",
        "--provenance",
        "--tag",
        "next",
      ],
      { cwd: fixtureRoot, encoding: "utf8", env: npmEnv },
    ),
  );
  // npm 11.19 keys publish results by package name; earlier npm 11 returns
  // the package object directly. Both must identify the one packed fixture.
  const publishedPackage = publishResult[fixtureManifest.name] ?? publishResult;
  if (publishedPackage !== publishResult)
    assert.deepEqual(Object.keys(publishResult), [fixtureManifest.name]);
  assert.equal(publishedPackage.id, `${fixtureManifest.name}@${fixtureManifest.version}`);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("Ferriki release workflow command and order contract verified");
