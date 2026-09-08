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

assert.doesNotThrow(() => assertReleaseWorkflow({ workflow, checklist, releaseConfig }));

const smokeStep =
  "      - name: Verify packed main-package consumer\n" +
  "        run: node ./scripts/check-packed-consumer.mjs\n\n";
assert.equal(workflow.match(new RegExp(smokeStep, "g"))?.length, 1);

const commandReplacedWithVersionCheck = workflow.replace(
  smokeStep,
  "      - name: Verify packed main-package consumer\n" +
    "        run: node --version\n" +
    "        # node ./scripts/check-packed-consumer.mjs\n\n",
);
assert.throws(
  () =>
    assertReleaseWorkflow({
      workflow: commandReplacedWithVersionCheck,
      checklist,
      releaseConfig,
    }),
  /executable packed-consumer smoke command/,
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
    }),
  /must precede the first npm publication step/,
);

console.log("Ferriki release workflow command and order contract verified");
