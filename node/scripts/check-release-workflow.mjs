import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function publishJob(workflow) {
  const startMarker = "\n  publish-npm:\n";
  const start = workflow.indexOf(startMarker);
  assert(start >= 0, "release workflow is missing publish-npm job");
  const body = workflow.slice(start + startMarker.length);
  const nextJob = body.search(/\n {2}[a-z0-9-]+:\s*\n/);
  return body.slice(0, nextJob >= 0 ? nextJob : body.length);
}

export function assertReleaseWorkflow({ workflow, checklist, releaseConfig }) {
  const releasePackage = releaseConfig.packages?.["node/ferriki"];
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
    "node",
    "Ferriki release authority must remain the Node package",
  );
  assert.equal(
    releaseConfig["include-component-in-tag"],
    false,
    "Ferriki must preserve the unscoped product tag format",
  );
  assert.equal(
    releasePackage?.["changelog-path"],
    "CHANGELOG.md",
    "release package must declare its changelog path",
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
  ])
    assert(workflow.includes(required), `release workflow is missing ${required}`);

  const publishWorkflow = publishJob(workflow);
  const smokeMatch = publishWorkflow.match(
    /^[ \t]+run:[ \t]+node \.\/scripts\/check-packed-consumer\.mjs\s*$/m,
  );
  assert(smokeMatch, "publish-npm must run an executable packed-consumer smoke command");
  const firstPublicationMatch = publishWorkflow.match(
    /^[ \t]+(?:run:[ \t]+)?npm publish\b/m,
  );
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
