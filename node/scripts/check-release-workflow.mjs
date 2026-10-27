import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function workflowJob(workflow, name) {
  const startMarker = `\n  ${name}:\n`;
  const start = workflow.indexOf(startMarker);
  assert(start >= 0, `release workflow is missing ${name} job`);
  const body = workflow.slice(start + startMarker.length);
  const nextJob = body.search(/\n {2}[a-z0-9-]+:\s*\n/);
  return body.slice(0, nextJob >= 0 ? nextJob : body.length);
}

// Dependency order: `ferriki` depends on the two library crates.
const CRATE_PUBLISH_ORDER = ["ferriki-textmate", "ferriki-asset-gen", "ferriki"];

export function assertReleaseWorkflow({ workflow, checklist, releaseConfig, nodePackage }) {
  const releasePackage = releaseConfig.packages?.["."];
  const extraFiles = releasePackage?.["extra-files"] ?? [];

  assert.match(
    workflow,
    /googleapis\/release-please-action@[0-9a-f]{40}/,
    "release workflow must pin release-please to an immutable commit",
  );
  assert.doesNotMatch(
    workflow,
    /uses: [^\n]+@(main|master|v\d)/,
    "release workflow must not follow mutable action refs",
  );
  assert.equal(
    releaseConfig["release-type"],
    "rust",
    "Ferriki release authority is the root Rust package (ADR 0012)",
  );
  assert.equal(
    releaseConfig["include-component-in-tag"],
    false,
    "Ferriki must preserve the unscoped product tag format",
  );
  assert.equal(
    releasePackage?.["changelog-path"],
    "node/ferriki/CHANGELOG.md",
    "release package must declare its changelog path",
  );
  assert(
    extraFiles.some(
      (file) => file.path === "/node/ferriki/package.json" && file.jsonpath === "$.version",
    ),
    "release config must update the npm package version with the product version",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/ferriki/package.json" && file.jsonpath === "$.optionalDependencies[*]",
    ),
    "release config must update all platform dependency versions with the product version",
  );
  assert(
    extraFiles.some(
      (file) => file.path === "/node/vite/package.json" && file.jsonpath === "$.version",
    ),
    "release config must update the Vite integration version with the product version",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/vite/package.json" &&
        file.jsonpath === "$.dependencies['@ferriki/core']",
    ),
    "release config must keep the Vite integration's Ferriki dependency on the product version",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/platforms/*/package.json" &&
        file.glob === true &&
        file.jsonpath === "$.version",
    ),
    "release config must update every platform package manifest with the product version",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/pnpm-lock.yaml" &&
        file.type === "yaml" &&
        file.jsonpath === "$.importers.ferriki.optionalDependencies[*].specifier",
    ),
    "release config must update the pnpm lockfile dependency specifiers",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/pnpm-lock.yaml" &&
        file.type === "yaml" &&
        file.jsonpath === "$.importers.vite.dependencies['@ferriki/core'].specifier",
    ),
    "release config must update the Vite importer dependency in the pnpm lockfile",
  );
  // The pinned Release Please TOML parser wraps scalar names in `.value`.
  // A registry copy of the same crate must keep its separately pinned version.
  for (const crate of ["ferriki-textmate", "ferriki-asset-gen"])
    assert(
      extraFiles.some(
        (file) =>
          file.path === "/fuzz/Cargo.lock" &&
          file.type === "toml" &&
          file.jsonpath === `$.package[?(@.name.value=='${crate}' && !@.source)].version`,
      ),
      `release config must update ${crate} in the separate fuzz lockfile`,
    );
  assert.match(
    nodePackage?.packageManager ?? "",
    /^pnpm@10\./,
    "the workspace must use pnpm 10 for catalog rewriting and npm 11 publishing",
  );
  assert.doesNotMatch(
    workflow,
    /sync:platform-versions/,
    "release workflow must not patch generated release candidates",
  );
  assert.match(
    workflow,
    /concurrency:\n {2}group: publish-\$\{\{ github\.repository \}\}\n {2}cancel-in-progress: false/,
    "main publication and tag recovery must share one non-canceling concurrency group",
  );
  for (const job of [
    "release-please:",
    "verify-release-source:",
    "publish-crates:",
    "build-native:",
    "publish-npm:",
    "verify-npm-publish:",
    "release-summary:",
  ])
    assert(workflow.includes(`  ${job}`), `release workflow is missing ${job}`);
  for (const required of [
    "force-publish:",
    "dist-tag:",
    "timeout-minutes:",
    "actions/download-artifact@",
    "verify-crates-publish:",
    "NPM_PUBLISH_RESULT:",
    "write-release-summary.mjs",
    // The package ships no payloads. Keep exact release provenance in the
    // manifest alongside immutable payload hashes (ADR 0013).
    'sync-standard-assets.mjs --release-commit "$(git rev-parse HEAD)"',
    // The publish job downloads native addons instead of running
    // build-native.mjs, so it must materialize the catalog and notices itself.
    "node ../scripts/materialize-assets.mjs --payloads",
    "node ../scripts/write-grammar-notices.mjs",
  ])
    assert(workflow.includes(required), `release workflow is missing ${required}`);

  const assetsJob = workflowJob(workflow, "publish-locked-assets");
  assert.match(
    workflow,
    /rebuild-assets:/,
    "asset publication must support rebuilding new locked payloads",
  );
  assert.match(
    assetsJob,
    /if: inputs\.rebuild-assets[\s\S]*run: node scripts\/rebuild-locked-assets\.mjs/,
    "asset rebuild must verify the reviewed lock before upload",
  );
  assert(
    assetsJob.indexOf("run: node scripts/rebuild-locked-assets.mjs") <
      assetsJob.indexOf("run: node scripts/publish-assets.mjs"),
    "locked asset rebuilding must precede publication",
  );

  const cratesJob = workflowJob(workflow, "publish-crates");
  const gateJob = workflowJob(workflow, "verify-release-source");
  assert.match(
    gateJob,
    /node \.\/node\/scripts\/release-source-gate\.mjs resolve/,
    "release source gate must resolve the tag and SHA",
  );
  assert.match(
    gateJob,
    /node \.\/node\/scripts\/release-source-gate\.mjs verify/,
    "release source gate must require exact-commit CI",
  );
  assert.match(gateJob, /actions: read/, "release source gate needs Actions read permission");
  assert.match(
    gateJob,
    /ref: \$\{\{ steps\.source\.outputs\.release_sha \}\}/,
    "release source gate must verify the exact checkout",
  );
  assert.match(
    gateJob,
    /release_sha: \$\{\{ steps\.source\.outputs\.release_sha \}\}/,
    "release source gate must export the verified SHA",
  );
  assert.match(
    workflow,
    /release-tag:\n\s+description:/,
    "force publication must require an explicit release tag",
  );
  for (const jobName of ["publish-crates", "build-native", "publish-npm", "verify-npm-publish"]) {
    const job = workflowJob(workflow, jobName);
    assert.match(
      job,
      /^\s+- verify-release-source\s*$/m,
      `${jobName} must depend on exact-release verification`,
    );
    assert.match(
      job,
      /ref: \$\{\{ needs\.verify-release-source\.outputs\.release_sha \}\}/,
      `${jobName} must check out the verified release SHA`,
    );
  }
  assert.match(
    cratesJob,
    /sebastian-software\/standards\/\.github\/actions\/publish-crates@[0-9a-f]{40}/,
    "publish-crates must use the shared, pinned standards action",
  );
  assert.match(
    cratesJob,
    /^\s+id-token: write\s*$/m,
    "publish-crates needs an OIDC token for crates.io Trusted Publishing",
  );
  assert.doesNotMatch(
    cratesJob,
    /CARGO_REGISTRY_TOKEN/,
    "publish-crates must not fall back to a long-lived registry token",
  );
  const crateList = cratesJob.match(/crates: \|\n((?:[ \t]+[a-z0-9-]+\n?)+)/);
  assert(crateList, "publish-crates must list the crates to publish");
  assert.deepEqual(
    crateList[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    CRATE_PUBLISH_ORDER,
    "publish-crates must publish the crates in dependency order",
  );

  const publishWorkflow = workflowJob(workflow, "publish-npm");
  assert.match(
    publishWorkflow,
    /uses: \.\/node\/node_modules\/ferramenta-native\/actions\/release-native/,
    "publish-npm must use the shared native release action",
  );
  assert.match(
    publishWorkflow,
    /source-sha: \$\{\{ needs\.verify-release-source\.outputs\.release_sha \}\}/,
    "native release must bind artifacts to the verified source",
  );
  assert.match(
    publishWorkflow,
    /tag: \$\{\{ needs\.verify-release-source\.outputs\.release_tag \}\}/,
    "native release must use the verified tag",
  );
  assert.match(
    publishWorkflow,
    /publish: "true"/,
    "native release must enable publication explicitly",
  );
  assert.match(
    publishWorkflow,
    /prepare-command: \|[\s\S]*pnpm run check:packed-vite/,
    "native release must include the packed Vite consumer check before publishing",
  );
  assert.match(
    publishWorkflow,
    /^\s+id-token: write\s*$/m,
    "publish-npm needs an OIDC token for npm Trusted Publishing",
  );

  // Every release summary lists each sidecar's addon size (#216).
  const summaryJob = workflowJob(workflow, "release-summary");
  const cratesVerifyJob = workflowJob(workflow, "verify-crates-publish");
  assert.match(
    cratesVerifyJob,
    /^\s+- publish-crates\s*$/m,
    "crates verification must wait for publication",
  );
  assert.match(
    cratesVerifyJob,
    /needs\.verify-release-source\.result == 'success'/,
    "crates verification must not check out an unverified release source",
  );
  assert.match(
    cratesVerifyJob,
    /verify-crates-publish\.mjs/,
    "crates verification must run the public verifier",
  );
  assert.match(summaryJob, /^\s+- publish-crates\s*$/m, "summary must wait for Rust publication");
  assert.match(
    summaryJob,
    /^\s+- verify-crates-publish\s*$/m,
    "summary must wait for Rust verification",
  );
  assert.match(summaryJob, /^\s+CRATES_RESULT: \$\{\{ needs\.publish-crates\.result \}\}\s*$/m);
  assert.match(
    summaryJob,
    /^\s+CRATES_VERIFY_RESULT: \$\{\{ needs\.verify-crates-publish\.result \}\}\s*$/m,
  );
  const sidecarDirectory = /^\s+pattern: native-\*\n\s+path: (\S+)$/m.exec(summaryJob)?.[1];
  assert(sidecarDirectory, "release-summary must download every native sidecar artifact");
  assert(
    summaryJob.includes(`NATIVE_SIDECARS_DIR: ${sidecarDirectory}\n`),
    "release-summary must report addon sizes from the downloaded sidecars",
  );

  for (const required of [
    "npm provenance",
    "GitHub release",
    "tarball",
    "rollback",
    "deprecate",
    "go/no-go",
    "Trusted Publishing",
    "Allow npm dist-tag",
    "@ferriki/vite",
    "0.0.0-bootstrap.0",
    "bootstrap",
    `cargo publish --locked ${CRATE_PUBLISH_ORDER.map((name) => `-p ${name}`).join(" ")}`,
  ])
    assert(
      checklist.toLowerCase().includes(required.toLowerCase()),
      `release checklist is missing ${required}`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const repoRoot = join(nodeRoot, "..");
  const workflow = await readFile(join(repoRoot, ".github/workflows/publish.yml"), "utf8");
  const checklist = await readFile(join(repoRoot, "docs/release-checklist.md"), "utf8");
  const releaseConfig = JSON.parse(
    await readFile(join(repoRoot, ".release-please-config.json"), "utf8"),
  );
  const nodePackage = JSON.parse(await readFile(join(nodeRoot, "package.json"), "utf8"));
  assertReleaseWorkflow({ workflow, checklist, releaseConfig, nodePackage });
  console.log("Ferriki release workflow and checklist verified");
}
