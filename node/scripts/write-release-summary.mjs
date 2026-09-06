import { appendFile } from "node:fs/promises";
import process from "node:process";

const releasesCreated = process.env.RELEASES_CREATED === "true";
const forcePublish = process.env.FORCE_PUBLISH === "true";
const intended = releasesCreated || forcePublish;
const releaseResult = process.env.RELEASE_RESULT ?? "unknown";
const buildResult = process.env.BUILD_RESULT ?? "unknown";
const publishResult = process.env.PUBLISH_RESULT ?? "unknown";
const verifyResult = process.env.VERIFY_RESULT ?? "unknown";
const releaseFailed = releaseResult !== "success";
const state =
  !intended && !releaseFailed
    ? "NO_RELEASE"
    : releaseResult === "success" &&
        buildResult === "success" &&
        publishResult === "success" &&
        verifyResult === "success"
      ? "PUBLISHED"
      : "FAILED";

const lines = [
  `## Ferriki release outcome: ${state}`,
  "",
  `- npm dist-tag: \`${process.env.NPM_DIST_TAG ?? "latest"}\``,
  `- release-please: \`${releaseResult}\` (releases created: \`${releasesCreated}\`)`,
  `- native build matrix: \`${buildResult}\``,
  `- npm publication: \`${publishResult}\``,
  `- public registry/install verification: \`${verifyResult}\``,
];
const summary = `${lines.join("\n")}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);

if (state === "FAILED") process.exitCode = 1;
