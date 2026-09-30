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

export function assertReleaseWorkflow({ workflow, checklist, releaseConfig }) {
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
  assert.doesNotMatch(
    workflow,
    /sync:platform-versions/,
    "release workflow must not patch generated release candidates",
  );
  for (const job of [
    "release-please:",
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
    "npm publish --access public --provenance",
    "NPM_PUBLISH_RESULT:",
    "write-release-summary.mjs",
    // The package ships no payloads; its release manifest must name the commit
    // whose tree the CDN serves, or installs cannot download (ADR 0013).
    'sync-standard-assets.mjs --release-commit "$(git rev-parse HEAD)"',
  ])
    assert(workflow.includes(required), `release workflow is missing ${required}`);

  const cratesJob = workflowJob(workflow, "publish-crates");
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
  const smokeMatch = publishWorkflow.match(
    /^[ \t]+run:[ \t]+node \.\/scripts\/check-packed-consumer\.mjs\s*$/m,
  );
  assert(smokeMatch, "publish-npm must run an executable packed-consumer smoke command");
  const firstPublicationMatch = publishWorkflow.match(/^[ \t]+(?:run:[ \t]+)?npm publish\b/m);
  assert(firstPublicationMatch, "publish-npm must contain an npm publication step");
  assert(
    smokeMatch.index < firstPublicationMatch.index,
    "packed-consumer smoke command must precede the first npm publication step",
  );

  for (const required of [
    "npm provenance",
    "GitHub release",
    "tarball",
    "rollback",
    "deprecate",
    "go/no-go",
    "Trusted Publishing",
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
  assertReleaseWorkflow({ workflow, checklist, releaseConfig });
  console.log("Ferriki release workflow and checklist verified");
}
