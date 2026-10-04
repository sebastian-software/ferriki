import { appendFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FERRIKI_PLATFORM_TARGETS } from "../ferriki/platforms.mjs";

/**
 * Reads each platform sidecar's addon from the release-summary job's artifact
 * download, where every `native-<platform id>` artifact has its own directory.
 * Targets keep the registry order; a target without an addon has no size.
 *
 * @param {string} directory
 * @param {readonly { id: string }[]} [targets]
 * @returns {Promise<{ id: string, bytes: number | undefined }[]>} Sizes per target.
 */
export async function readSidecarAddonSizes(directory, targets = FERRIKI_PLATFORM_TARGETS) {
  const sizes = [];
  for (const { id } of targets) {
    let bytes;
    try {
      bytes = (await stat(join(directory, `native-${id}`, "ferriki.node"))).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    sizes.push({ id, bytes });
  }
  return sizes;
}

function formatBytes(bytes) {
  const grouped = String(bytes).replace(/\B(?=(?:\d{3})+$)/g, ",");
  return `${grouped} bytes (${(bytes / 1e6).toFixed(2)} MB)`;
}

/**
 * @param {Record<string, string | undefined>} env The workflow's job results.
 * @param {readonly { id: string, bytes: number | undefined }[]} [addonSizes]
 * @returns {{ state: "NO_RELEASE" | "PUBLISHED" | "FAILED", summary: string }} Outcome and Markdown.
 */
export function formatReleaseSummary(env, addonSizes = []) {
  const releasesCreated = env.RELEASES_CREATED === "true";
  const forcePublish = env.FORCE_PUBLISH === "true";
  const intended = releasesCreated || forcePublish;
  const releaseResult = env.RELEASE_RESULT ?? "unknown";
  const buildResult = env.BUILD_RESULT ?? "unknown";
  const publishResult = env.PUBLISH_RESULT ?? "unknown";
  const verifyResult = env.VERIFY_RESULT ?? "unknown";
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
    `- npm dist-tag: \`${env.NPM_DIST_TAG ?? "latest"}\``,
    `- release-please: \`${releaseResult}\` (releases created: \`${releasesCreated}\`)`,
    `- native build matrix: \`${buildResult}\``,
    `- npm publication: \`${publishResult}\``,
    `- public registry/install verification: \`${verifyResult}\``,
  ];
  // Addon growth is otherwise visible only after installation (#216).
  if (addonSizes.length > 0) {
    lines.push("", "### Native addon sizes", "", "| Target | Unpacked `ferriki.node` |");
    lines.push("| --- | ---: |");
    for (const { id, bytes } of addonSizes)
      lines.push(`| \`${id}\` | ${bytes === undefined ? "missing" : formatBytes(bytes)} |`);
  }
  return { state, summary: `${lines.join("\n")}\n` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sidecarDirectory = process.env.NATIVE_SIDECARS_DIR;
  const addonSizes =
    sidecarDirectory && process.env.BUILD_RESULT !== "skipped"
      ? await readSidecarAddonSizes(resolve(sidecarDirectory))
      : [];
  const { state, summary } = formatReleaseSummary(process.env, addonSizes);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);

  if (state === "FAILED") process.exitCode = 1;
}
