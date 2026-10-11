import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FERRIKI_PLATFORM_TARGETS } from "../ferriki/platforms.mjs";
import {
  checkManifestVersions,
  fetchCiRuns,
  inspectCiJobs,
  inspectCiRuns,
  releaseTarget,
  resolveTag,
} from "./release-source-gate.mjs";

const sha = "a".repeat(40);
const other = "b".repeat(40);
const normal = {
  force: false,
  releaseSha: sha,
  releaseTag: "v0.13.0",
  releaseVersion: "0.13.0",
  eventSha: sha,
  eventRef: "refs/heads/main",
};
assert.deepEqual(releaseTarget(normal), { tag: "v0.13.0", version: "0.13.0", expectedSha: sha });
assert.throws(
  () => releaseTarget({ ...normal, releaseSha: other }),
  /differs from the push commit/,
);
assert.throws(
  () => releaseTarget({ ...normal, releaseVersion: "0.12.0" }),
  /tag and version differ/,
);
assert.throws(
  () => releaseTarget({ ...normal, eventRef: "refs/pull/1/merge" }),
  /must run from main/,
);
const force = { force: true, inputTag: "v0.13.0", eventSha: sha, eventRef: "refs/tags/v0.13.0" };
assert.deepEqual(releaseTarget(force), { tag: "v0.13.0", version: "0.13.0", expectedSha: sha });
assert.throws(
  () => releaseTarget({ ...force, eventRef: "refs/heads/main" }),
  /exact release tag ref/,
);
assert.throws(() => releaseTarget({ ...force, inputTag: "" }), /explicit v<version>/);

assert.equal(await resolveTag(async () => ({ object: { type: "commit", sha } }), "v0.13.0"), sha);
assert.equal(
  await resolveTag(
    async (path) =>
      path.startsWith("/git/ref/")
        ? { object: { type: "tag", sha: other } }
        : { object: { type: "commit", sha } },
    "v0.13.0",
  ),
  sha,
);
await assert.rejects(
  resolveTag(async () => ({ object: { type: "tree", sha } }), "v0.13.0"),
  /must resolve to a commit/,
);

const run = (overrides = {}) => ({
  id: 100,
  created_at: "2026-10-10T20:00:00Z",
  head_sha: sha,
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yml@main",
  status: "completed",
  conclusion: "success",
  ...overrides,
});
const stalePr = run({ id: 101, event: "pull_request", head_branch: "feature" });
const otherSha = run({ id: 102, head_sha: other });
const publishRun = run({ id: 103, path: ".github/workflows/publish.yml@main" });
assert.equal(inspectCiRuns([stalePr, otherSha, publishRun], sha).state, "pending");
assert.equal(inspectCiRuns([run()], sha).state, "check-jobs");
for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"])
  assert.equal(inspectCiRuns([run({ conclusion })], sha).state, "denied");
assert.equal(
  inspectCiRuns([run({ status: "in_progress", conclusion: null })], sha).state,
  "pending",
);
// A newer failed run takes precedence over earlier green evidence. A rerun
// updates the same run ID and can turn that latest evidence green.
assert.equal(
  inspectCiRuns(
    [run(), run({ id: 104, created_at: "2026-10-10T20:01:00Z", conclusion: "failure" })],
    sha,
  ).state,
  "denied",
);
assert.equal(
  inspectCiRuns(
    [run({ id: 104, created_at: "2026-10-10T20:01:00Z" }), run({ conclusion: "failure" })],
    sha,
  ).state,
  "check-jobs",
);

const jobs = [
  "workflow-pins",
  "Decision records",
  "rust",
  "rust-semver",
  "msrv",
  "rust-docs",
  "cargo-deny",
  "coverage",
  "lint",
  "typecheck",
  "textmate-compat",
  "core-compat",
  "Test on macos-latest",
  "Test on windows-latest",
  ...FERRIKI_PLATFORM_TARGETS.map(({ id }) => `native-smoke (22.x, ${id})`),
].map((name) => ({ name, head_sha: sha, conclusion: "success" }));
assert.equal(inspectCiJobs(jobs, sha).state, "allowed");
// Stable Rust compatibility is part of publication readiness, even if a
// workflow run is otherwise green because this job was removed or skipped.
for (const conclusion of [null, "failure", "cancelled", "skipped"]) {
  assert.match(
    inspectCiJobs(
      jobs.map((job) => (job.name === "rust-semver" ? { ...job, conclusion } : job)),
      sha,
    ).detail,
    /rust-semver/,
  );
}
assert.match(
  inspectCiJobs(
    jobs.filter((job) => job.name !== "rust-semver"),
    sha,
  ).detail,
  /rust-semver/,
);
assert.match(
  inspectCiJobs(
    jobs.filter((job) => job.name !== "core-compat"),
    sha,
  ).detail,
  /core-compat/,
);
assert.match(
  inspectCiJobs(
    jobs.map((job) => (job.name === "lint" ? { ...job, conclusion: "failure" } : job)),
    sha,
  ).detail,
  /lint/,
);
const lastPlatform = FERRIKI_PLATFORM_TARGETS.at(-1).id;
assert.match(
  inspectCiJobs(
    jobs.filter((job) => !job.name.includes(lastPlatform)),
    sha,
  ).detail,
  new RegExp(`native-smoke ${lastPlatform}`),
);
assert.match(
  inspectCiJobs([...jobs, jobs.find((job) => job.name.includes(lastPlatform))], sha).detail,
  new RegExp(`native-smoke ${lastPlatform} \\(2/1\\)`),
);
assert.equal(
  inspectCiJobs(
    jobs.map((job) => ({ ...job, head_sha: other })),
    sha,
  ).state,
  "denied",
);

const paths = [];
const paged = await fetchCiRuns(async (path) => {
  paths.push(path);
  return path.includes("page=1")
    ? { total_count: 2, workflow_runs: [run({ id: 104, conclusion: "failure" })] }
    : { total_count: 2, workflow_runs: [run()] };
}, sha);
assert.equal(paths.length, 2);
assert.equal(inspectCiRuns(paged, sha).state, "denied");
assert(
  paths.every(
    (path) =>
      path.includes(`head_sha=${sha}`) &&
      path.includes("event=push") &&
      path.includes("branch=main"),
  ),
);
await assert.rejects(
  fetchCiRuns(async () => ({ total_count: 1001, workflow_runs: [] }), sha),
  /result bound/,
);

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const manifestVersion = JSON.parse(
  await readFile(join(repoRoot, "node/ferriki/package.json"), "utf8"),
).version;
await checkManifestVersions(repoRoot, manifestVersion, sha);
await assert.rejects(checkManifestVersions(repoRoot, "0.0.0", sha), /version differs/);
console.log("Ferriki exact release source deny/allow decisions verified");
