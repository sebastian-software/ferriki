import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { FERRIKI_PLATFORM_TARGETS } from "../ferriki/platforms.mjs";

const SHA = /^[0-9a-f]{40}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_JOBS = [
  "workflow-pins",
  "Decision records",
  "rust",
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
];
const POLL_MS = 20_000;
const TIMEOUT_MS = 30 * 60_000;

export function releaseTarget({
  force,
  inputTag,
  releaseSha,
  releaseTag,
  releaseVersion,
  eventSha,
  eventRef,
}) {
  assert(SHA.test(eventSha), "GitHub event SHA is missing or malformed");
  if (force) {
    assert(TAG.test(inputTag), "force-publish requires an explicit v<version> release-tag");
    assert.equal(
      eventRef,
      `refs/tags/${inputTag}`,
      "force-publish must dispatch on the exact release tag ref",
    );
    return { tag: inputTag, version: inputTag.slice(1), expectedSha: eventSha };
  }
  assert.equal(eventRef, "refs/heads/main", "normal release must run from main");
  assert(SHA.test(releaseSha), "Release Please did not provide a release SHA");
  assert(TAG.test(releaseTag), "Release Please did not provide a release tag");
  assert.equal(releaseVersion, releaseTag.slice(1), "Release Please tag and version differ");
  assert.equal(releaseSha, eventSha, "Release Please SHA differs from the push commit");
  return { tag: releaseTag, version: releaseVersion, expectedSha: releaseSha };
}

export async function resolveTag(api, tag) {
  const ref = await api(`/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref.object;
  for (let depth = 0; depth < 3 && object?.type === "tag"; depth++) {
    object = (await api(`/git/tags/${object.sha}`)).object;
  }
  assert.equal(object?.type, "commit", `release tag ${tag} must resolve to a commit`);
  assert(SHA.test(object.sha), `release tag ${tag} has an invalid commit SHA`);
  return object.sha;
}

export function inspectCiRuns(runs, sha) {
  const matching = runs.filter(
    (run) =>
      run.head_sha === sha &&
      run.event === "push" &&
      run.head_branch === "main" &&
      run.path?.split("@")[0] === ".github/workflows/ci.yml",
  );
  if (!matching.length) return { state: "pending", detail: `No CI push/main run for ${sha}` };
  matching.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const run = matching[0];
  if (run.status !== "completed")
    return { state: "pending", detail: `CI run ${run.id} is ${run.status}`, run };
  if (run.conclusion !== "success")
    return { state: "denied", detail: `CI run ${run.id} concluded ${run.conclusion}`, run };
  return { state: "check-jobs", detail: `CI run ${run.id} succeeded`, run };
}

export function inspectCiJobs(jobs, sha) {
  const missing = [];
  for (const name of REQUIRED_JOBS) {
    if (
      !jobs.some((job) => job.name === name && job.head_sha === sha && job.conclusion === "success")
    )
      missing.push(name);
  }
  for (const { id } of FERRIKI_PLATFORM_TARGETS) {
    const platformJobs = jobs.filter(
      (job) =>
        job.name.startsWith("native-smoke (") &&
        job.name.includes(id) &&
        job.head_sha === sha &&
        job.conclusion === "success",
    );
    if (platformJobs.length !== 1) missing.push(`native-smoke ${id} (${platformJobs.length}/1)`);
  }
  return missing.length
    ? { state: "denied", detail: `Missing or unsuccessful required CI jobs: ${missing.join(", ")}` }
    : { state: "allowed", detail: "Required CI jobs succeeded" };
}

export async function fetchCiRuns(api, sha) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({
      head_sha: sha,
      event: "push",
      branch: "main",
      per_page: "100",
      page: String(page),
    });
    const data = await api(`/actions/workflows/ci.yml/runs?${query}`);
    assert(
      Array.isArray(data.workflow_runs) && Number.isInteger(data.total_count),
      "CI run response is malformed",
    );
    assert(data.total_count <= 1000, "CI run search exceeds the GitHub API result bound");
    runs.push(...data.workflow_runs);
    if (runs.length >= data.total_count) return runs;
    assert(data.workflow_runs.length > 0, "CI run pagination ended before total_count");
  }
  throw new Error("CI run listing exceeds the verification bound");
}

export async function checkManifestVersions(root, version, sha) {
  assert(SHA.test(sha), "release SHA is invalid");
  assert.equal(
    JSON.parse(await readFile(join(root, ".release-please-manifest.json"), "utf8"))["."],
    version,
    "Release Please manifest version differs from the tag",
  );
  const cargoFiles = [
    "Cargo.toml",
    "crates/ferriki-textmate/Cargo.toml",
    "crates/ferriki-asset-gen/Cargo.toml",
  ];
  for (const file of cargoFiles) {
    const content = await readFile(join(root, file), "utf8");
    assert.match(
      content,
      new RegExp(`^version = "${version.replaceAll(".", "\\.")}"$`, "m"),
      `${file} version differs from ${version}`,
    );
  }
  const npmFiles = ["node/ferriki/package.json", "node/vite/package.json"];
  for (const platform of FERRIKI_PLATFORM_TARGETS)
    npmFiles.push(`node/platforms/${platform.id}/package.json`);
  for (const file of npmFiles) {
    const manifest = JSON.parse(await readFile(join(root, file), "utf8"));
    assert.equal(manifest.version, version, `${file} version differs from ${version}`);
    if (file === "node/ferriki/package.json") {
      for (const platform of FERRIKI_PLATFORM_TARGETS)
        assert.equal(
          manifest.optionalDependencies[platform.packageName],
          version,
          `${file} optional dependency ${platform.packageName} differs from ${version}`,
        );
    }
    if (file === "node/vite/package.json")
      assert.equal(
        manifest.dependencies["@ferriki/core"],
        version,
        `${file} core dependency differs from ${version}`,
      );
  }
  const assetManifest = JSON.parse(
    await readFile(join(root, "assets/shiki/release-manifest.json"), "utf8"),
  );
  assert.equal(assetManifest.manifestVersion, 1, "release asset manifest version is unsupported");
  assert(Object.keys(assetManifest.assets ?? {}).length > 0, "release asset manifest is empty");
}

async function main() {
  const [command] = process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  assert(
    token && /^[\w.-]+\/[\w.-]+$/.test(repository ?? ""),
    "GitHub API credentials or repository are missing",
  );
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
    return response.json();
  };
  if (command === "resolve") {
    const target = releaseTarget({
      force: process.env.FORCE_PUBLISH === "true",
      inputTag: process.env.INPUT_RELEASE_TAG,
      releaseSha: process.env.RELEASE_PLEASE_SHA,
      releaseTag: process.env.RELEASE_PLEASE_TAG,
      releaseVersion: process.env.RELEASE_PLEASE_VERSION,
      eventSha: process.env.GITHUB_SHA,
      eventRef: process.env.GITHUB_REF,
    });
    const sha = await resolveTag(api, target.tag);
    if (target.expectedSha)
      assert.equal(sha, target.expectedSha, "release tag does not point to the Release Please SHA");
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `release_sha=${sha}\nrelease_tag=${target.tag}\nrelease_version=${target.version}\n`,
    );
    console.log(`Resolved ${target.tag} to ${sha}`);
  } else if (command === "verify") {
    const sha = process.env.RELEASE_SHA;
    assert(SHA.test(sha), "release SHA is missing or malformed");
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: process.env.GITHUB_WORKSPACE,
        encoding: "utf8",
      }).trim(),
      sha,
      "checkout differs from verified release SHA",
    );
    await checkManifestVersions(process.env.GITHUB_WORKSPACE, process.env.RELEASE_VERSION, sha);
    const deadline = Date.now() + TIMEOUT_MS;
    let last = "No matching CI run";
    while (Date.now() < deadline) {
      const runs = await fetchCiRuns(api, sha);
      const result = inspectCiRuns(runs, sha);
      last = result.detail;
      if (result.state === "denied") throw new Error(last);
      if (result.state === "check-jobs") {
        const jobs = [];
        for (let page = 1; page <= 10; page++) {
          const data = await api(
            `/actions/runs/${result.run.id}/jobs?filter=latest&per_page=100&page=${page}`,
          );
          jobs.push(...data.jobs);
          if (jobs.length >= data.total_count) break;
          if (page === 10) throw new Error("CI job listing exceeds the verification bound");
        }
        const decision = inspectCiJobs(jobs, sha);
        if (decision.state !== "allowed")
          throw new Error(`${decision.detail} in CI run ${result.run.id}`);
        console.log(`Verified CI push/main run ${result.run.id} for exact release commit ${sha}`);
        return;
      }
      console.log(`${last}; waiting for exact-commit CI`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, deadline - Date.now())));
    }
    throw new Error(`Timed out waiting for exact-commit CI: ${last}`);
  } else {
    throw new Error("usage: release-source-gate.mjs resolve|verify");
  }
}

if (process.argv[1]?.endsWith("/release-source-gate.mjs"))
  main().catch((error) => {
    console.error(`Release source gate denied publication: ${error.message}`);
    process.exitCode = 1;
  });
