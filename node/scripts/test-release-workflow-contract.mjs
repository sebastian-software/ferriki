import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

const smokeStep =
  "      - name: Verify packed main-package consumer\n" +
  "        run: node ./scripts/check-packed-consumer.mjs\n" +
  "        env:\n" +
  "          FERRIKI_PLATFORM_ID: linux-x64-gnu\n\n";
assert.equal(workflow.match(new RegExp(smokeStep, "g"))?.length, 1);

const commandReplacedWithVersionCheck = workflow.replace(
  smokeStep,
  "      - name: Verify packed main-package consumer\n" +
    "        run: node --version\n" +
    "        # node ./scripts/check-packed-consumer.mjs\n" +
    "        env:\n" +
    "          FERRIKI_PLATFORM_ID: linux-x64-gnu\n\n",
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: commandReplacedWithVersionCheck,
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /packed core-consumer smoke command/,
);

const withoutSmokeStep = workflow.replace(smokeStep, "");
const mainPublicationStep = "      - name: Publish main package with npm provenance\n";
const mainPublicationOffset = withoutSmokeStep.indexOf(mainPublicationStep);
assert(mainPublicationOffset >= 0, "fixture must contain the main publication step");
const smokeStepMovedAfterPublication =
  withoutSmokeStep.slice(0, mainPublicationOffset) +
  smokeStep +
  withoutSmokeStep.slice(mainPublicationOffset);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: smokeStepMovedAfterPublication,
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must precede the first registry publication step/,
);

const viteSmokeStep =
  "      - name: Verify packed Vite consumer\n" +
  "        run: pnpm run check:packed-vite\n" +
  "        env:\n" +
  "          FERRIKI_PLATFORM_ID: linux-x64-gnu\n\n";
assert.equal(workflow.match(new RegExp(viteSmokeStep, "g"))?.length, 1);
const withoutViteSmokeStep = workflow.replace(viteSmokeStep, "");
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: withoutViteSmokeStep,
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /packed Vite consumer smoke command/,
);
const corePublishStep = "      - name: Publish main package with npm provenance\n";
const corePublicationOffset = withoutViteSmokeStep.indexOf(corePublishStep);
assert(corePublicationOffset >= 0, "fixture must contain the main publication step");
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow:
        withoutViteSmokeStep.slice(0, corePublicationOffset) +
        viteSmokeStep +
        withoutViteSmokeStep.slice(corePublicationOffset),
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /packed Vite consumer smoke command must precede the first registry publication step/,
);

const publishJobMarker = "\n  publish-npm:\n";
const publishJobStart = workflow.indexOf(publishJobMarker);
const publishJobBodyStart = publishJobStart + publishJobMarker.length;
const publishJobEnd = workflow.indexOf("\n  verify-npm-publish:\n", publishJobBodyStart);
assert(publishJobStart >= 0 && publishJobEnd > publishJobBodyStart);
const publishJob = workflow.slice(publishJobBodyStart, publishJobEnd);
const vitePublishBlockStart = publishJob.indexOf("      # pnpm rewrites the package's catalog:");
const vitePublishBlockEnd = publishJob.length;
assert(vitePublishBlockStart >= 0 && vitePublishBlockEnd > vitePublishBlockStart);
const vitePublishBlock = publishJob.slice(vitePublishBlockStart, vitePublishBlockEnd);
const publishJobWithoutVite =
  publishJob.slice(0, vitePublishBlockStart) + publishJob.slice(vitePublishBlockEnd);
const corePublishOffset = publishJobWithoutVite.indexOf(mainPublicationStep);
assert(corePublishOffset >= 0, "fixture must publish core");
const vitePublishBeforeCore =
  publishJobWithoutVite.slice(0, corePublishOffset) +
  vitePublishBlock +
  publishJobWithoutVite.slice(corePublishOffset);
const workflowWithViteBeforeCore =
  workflow.slice(0, publishJobBodyStart) + vitePublishBeforeCore + workflow.slice(publishJobEnd);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: workflowWithViteBeforeCore,
      checklist,
      releaseConfig,
      nodePackage,
    }),
  /must publish after its @ferriki\/core dependency/,
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

console.log("Ferriki release workflow command and order contract verified");
