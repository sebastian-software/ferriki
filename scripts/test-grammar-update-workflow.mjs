import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const { load } = createRequire(new URL("../node/package.json", import.meta.url))("js-yaml");
const workflow = load(
  await readFile(new URL("../.github/workflows/grammar-updates.yml", import.meta.url), "utf8"),
);
const baseJob = workflow.jobs["resolve-base"];
const prepareJob = workflow.jobs.prepare;
const verifyJob = workflow.jobs.verify;
const publishJob = workflow.jobs.publish;
assert(baseJob, "grammar-updates workflow must define a trusted resolve-base job");
assert(prepareJob, "grammar-updates workflow must define a read-only prepare job");
assert(verifyJob, "grammar-updates workflow must define an isolated verify job");
assert(publishJob, "grammar-updates workflow must define a write-scoped publish job");
const releaseWorkflow = load(
  await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8"),
);
assert.equal(releaseWorkflow.on.workflow_dispatch.inputs["assets-only"].default, false);
assert.equal(
  releaseWorkflow.jobs["release-please"].if,
  `\${{ !(github.event_name == 'workflow_dispatch' && inputs.assets-only) }}`,
  "asset-only dispatch must skip release management and all dependent registry jobs",
);
const assetOnly = releaseWorkflow.jobs["publish-locked-assets"];
assert.equal(
  releaseWorkflow.jobs["release-summary"].if,
  `\${{ always() && !(github.event_name == 'workflow_dispatch' && inputs.assets-only) }}`,
  "asset-only dispatch must not report a skipped package release as a failure",
);
assert.equal(assetOnly.if, `\${{ github.event_name == 'workflow_dispatch' && inputs.assets-only }}`);
assert.equal(assetOnly.steps[0].with["persist-credentials"], false);
const cleanup = assetOnly.steps.find((step) => step.name === "Remove verified migration objects");
const retirement = assetOnly.steps.find(
  (step) => step.name === "Retire complete prepared packages",
);
assert.equal(
  releaseWorkflow.on.workflow_dispatch.inputs["retire-complete-prepared-assets"].default,
  false,
);
assert.equal(retirement.if, "inputs.retire-complete-prepared-assets");
assert(
  assetOnly.steps.indexOf(retirement) >
    assetOnly.steps.findIndex((step) => step.name === "Verify public CDN objects"),
);
assert.match(retirement.run, /test-retire-prepared-assets\.mjs/);
assert.match(retirement.run, /retire-prepared-assets\.mjs --apply/);
assert.equal(cleanup.if, "inputs.cleanup-bootstrap-assets");
assert(
  assetOnly.steps.indexOf(cleanup) >
    assetOnly.steps.findIndex((step) => step.name === "Verify public CDN objects"),
);
const assetCommands = assetOnly.steps.map((step) => step.run || "").join("\n");
assert.doesNotMatch(assetCommands, /cargo publish|pnpm publish|publish-npm|release-please/);
assert(assetCommands.indexOf("publish-assets.mjs") < assetCommands.indexOf("verify-assets.mjs"));
assert.deepEqual(
  workflow.permissions,
  { contents: "read" },
  "grammar-updates top-level permissions must be least privilege (contents: read)",
);
assert.deepEqual(
  baseJob.permissions,
  { contents: "read" },
  "resolve-base job must run with read-only permissions",
);
assert.equal(baseJob.steps[0].with.ref, `\${{ github.event.repository.default_branch }}`);
assert.equal(baseJob.steps[0].with["persist-credentials"], false);
assert.equal(baseJob.env.UPDATE_BRANCH, "codex/grammar-updates");
assert.equal(baseJob.outputs.expected_update_sha, `\${{ steps.base.outputs.expected_update_sha }}`);
assert.equal(baseJob.outputs.repo_pins, `\${{ steps.base.outputs.repo_pins }}`);
assert.match(
  baseJob.steps.find((step) => step.id === "base").run,
  /node scripts\/write-grammar-notices\.mjs --resolve-pins/,
  "resolve-base must resolve upstream repository commit pins once for both prepare and verify",
);
assert.doesNotMatch(
  JSON.stringify(baseJob),
  /pnpm|cargo|npm|BUNNY_STORAGE_ACCESS_KEY/,
  "resolve-base job must not execute package managers, builds, or access secrets",
);
assert.deepEqual(
  prepareJob.permissions,
  { contents: "read" },
  "prepare job must run with read-only permissions",
);
assert.equal(prepareJob.needs, "resolve-base");
assert.equal(
  prepareJob.outputs?.base_sha,
  undefined,
  "prepare job must not control the commit SHA checked out by publish",
);
assert.deepEqual(
  verifyJob.permissions,
  { contents: "read" },
  "verify job must run with read-only permissions (no write scopes)",
);
assert.deepEqual(verifyJob.needs, ["resolve-base", "prepare"]);
assert.equal(verifyJob.if, "needs.prepare.outputs.changed == 'true'");
assert.equal(verifyJob.outputs.bundle_sha256, `\${{ steps.verify.outputs.bundle_sha256 }}`);
for (const [jobLabel, jobDef] of [
  ["prepare", prepareJob],
  ["verify", verifyJob],
  ["publish", publishJob],
]) {
  assert.equal(
    jobDef.steps[0].name,
    "Verify resolved base commit",
    `${jobLabel} must validate resolved BASE_SHA before actions/checkout`,
  );
  assert.equal(
    jobDef.steps[0].env.BASE_SHA,
    `\${{ needs.resolve-base.outputs.sha }}`,
    `${jobLabel} base SHA validation step must inspect needs.resolve-base.outputs.sha`,
  );
  assert.match(jobDef.steps[0].run, /\^\[0-9a-f\]\{40\}\$/);
  assert.equal(
    jobDef.steps[1].with.ref,
    `\${{ needs.resolve-base.outputs.sha }}`,
    `${jobLabel} checkout must follow base SHA validation`,
  );
  assert.equal(jobDef.steps[1].with["persist-credentials"], false);
}
assert.doesNotMatch(
  JSON.stringify(verifyJob),
  /BUNNY_STORAGE_ACCESS_KEY|Swatinem\/rust-cache|build:native|test:ferriki-compat|check:bench-/,
  "verify job must not access Bunny secrets, share Rust build cache, or run compat/bench suites",
);
const verifyBuildStep = verifyJob.steps.find((step) => step.name === "Build asset generator");
assert(verifyBuildStep, "verify job must build ferriki-asset-gen");
assert.match(verifyBuildStep.run, /cargo build --release --locked -p ferriki-asset-gen/);
const verifyRebuildStep = verifyJob.steps.find(
  (step) => step.name === "Rebuild and verify candidate bundle from locked pins",
);
assert(verifyRebuildStep, "verify job must independently rebuild and compare the publish bundle");
assert.equal(
  verifyRebuildStep.env.REPO_PINS,
  `\${{ needs.resolve-base.outputs.repo_pins }}`,
  "verify job must receive trusted repo_pins from resolve-base",
);
assert.match(
  verifyRebuildStep.run,
  /node scripts\/prepare-grammar-update\.mjs --locked-from "\$PREPARE_BUNDLE\/assets\/grammars\/sources\.json" --repo-pins "\$REPO_PINS"/,
);
assert.match(
  verifyRebuildStep.run,
  /node scripts\/write-grammar-diffs\.mjs "\$REBUILT_CANDIDATE"/,
  "verify job must generate reviewer-facing grammar diffs before applying candidate",
);
assert(
  verifyRebuildStep.run.indexOf('node scripts/write-grammar-diffs.mjs "$REBUILT_CANDIDATE"') <
    verifyRebuildStep.run.indexOf('node scripts/apply-grammar-update.mjs "$REBUILT_CANDIDATE"'),
  "verify job must generate diffs against BASE_SHA before apply-grammar-update overwrites grammars",
);
assert.match(verifyRebuildStep.run, /node scripts\/apply-grammar-update\.mjs "\$REBUILT_CANDIDATE"/);
assert.match(
  verifyRebuildStep.run,
  /node scripts\/materialize-assets\.mjs --metadata-only/,
  "verify job must regenerate standard metadata identically to prepare before comparing bundles",
);
assert.match(
  verifyRebuildStep.run,
  /node scripts\/write-grammar-notices\.mjs --check --base-catalog "\$base_catalog" --base-sources "\$base_sources" --repo-pins "\$REPO_PINS"/,
);
assert.match(
  verifyRebuildStep.run,
  /node scripts\/verify-grammar-bundle\.mjs "\$VERIFIED_BUNDLE" "\$PREPARE_BUNDLE"/,
);
assert.match(verifyRebuildStep.run, /bundle_sha256=/);
assert.equal(
  prepareJob.outputs.publish_bundle_artifact,
  `grammar-publish-bundle-\${{ github.run_attempt }}`,
);
assert.equal(
  prepareJob.outputs.candidate_artifact,
  `grammar-candidate-\${{ github.run_attempt }}`,
);
const verifyDownloadStep = verifyJob.steps.find(
  (step) => step.name === "Download prepared publish bundle",
);
assert.equal(
  verifyDownloadStep.with.name,
  `\${{ needs.prepare.outputs.publish_bundle_artifact }}`,
  "verify job must download the attempt-scoped publish bundle output from prepare",
);
const verifyUploadStep = verifyJob.steps.find(
  (step) => step.name === "Upload verified publish bundle",
);
assert(verifyUploadStep, "verify job must upload grammar-verified-bundle");
assert.equal(verifyUploadStep.with.name, `grammar-verified-bundle-\${{ github.run_attempt }}`);
assert.equal(verifyUploadStep.with.overwrite, true);
assert.equal(
  verifyJob.outputs.bundle_artifact,
  `grammar-verified-bundle-\${{ github.run_attempt }}`,
);
const verifyDiffsUploadStep = verifyJob.steps.find(
  (step) => step.name === "Upload verified review diffs",
);
assert(verifyDiffsUploadStep, "verify job must upload grammar-verified-diffs");
assert.equal(verifyDiffsUploadStep.with.name, `grammar-verified-diffs-\${{ github.run_attempt }}`);
assert.equal(verifyDiffsUploadStep.with.overwrite, true);
assert.equal(
  verifyJob.outputs.diffs_artifact,
  `grammar-verified-diffs-\${{ github.run_attempt }}`,
);
assert.deepEqual(
  publishJob.permissions,
  { contents: "write", "pull-requests": "write" },
  "publish job must declare write permissions only where needed",
);
assert.doesNotMatch(
  JSON.stringify(prepareJob),
  /BUNNY_STORAGE_ACCESS_KEY/,
  "prepare job must not access Bunny storage secrets",
);
assert.deepEqual(publishJob.needs, ["resolve-base", "prepare", "verify"]);
assert.equal(publishJob.if, "needs.prepare.outputs.changed == 'true'");
const publication = publishJob.steps.find((step) => step.name === "Open a reviewable update");
const candidatePath = `\${{ runner.temp }}/grammar-candidate`;
assert.equal(prepareJob.env?.CANDIDATE, undefined);
assert.equal(publishJob.env?.CANDIDATE, undefined);
assert.equal(publishJob.env?.GH_TOKEN, undefined);
for (const name of [
  "Prepare repository snapshots",
  "Validate and apply the candidate",
  "Stage verified assets for publication",
]) {
  const step = prepareJob.steps.find((candidate) => candidate.name === name);
  assert.equal(
    step.env.CANDIDATE,
    candidatePath,
    `${name} must use the runner temp candidate path`,
  );
}
for (const name of ["Restore verified candidate files", "Open a reviewable update"]) {
  const step = publishJob.steps.find((candidate) => candidate.name === name);
  assert.equal(
    step.env.CANDIDATE,
    candidatePath,
    `${name} must use the runner temp candidate path`,
  );
}
assert.equal(publication.env.GH_TOKEN, `\${{ secrets.GITHUB_TOKEN }}`);
assert.equal(publication.env.BASE_SHA, `\${{ needs.resolve-base.outputs.sha }}`);
assert.equal(
  publication.env.EXPECTED_UPDATE_SHA,
  `\${{ needs.resolve-base.outputs.expected_update_sha }}`,
);
assert.equal(
  publication.env.DIFFS_ARTIFACT,
  `\${{ needs.verify.outputs.diffs_artifact }}`,
  "publication step must pass the exact attempt-scoped diffs artifact name into the PR body",
);
assert.match(
  publication.run,
  /write-grammar-update-report\.mjs --diffs-artifact "\$\{DIFFS_ARTIFACT:-grammar-verified-diffs\}"/,
);
const artifact = prepareJob.steps.find(
  (step) => step.name === "Keep the candidate and its report",
);
assert.equal(artifact.with.path, candidatePath);
assert.equal(artifact.with.name, `grammar-candidate-\${{ github.run_attempt }}`);
assert.equal(artifact.with.overwrite, true);
assert.equal(workflow.on.schedule[0].cron, "0 6 * * 1");
assert(Object.hasOwn(workflow.on, "workflow_dispatch"));
assert.equal(publishJob.env.UPDATE_BRANCH, "codex/grammar-updates");
const stageIndex = prepareJob.steps.findIndex(
  (step) => step.name === "Stage verified assets for publication",
);
const uploadBundleIndex = prepareJob.steps.findIndex(
  (step) => step.name === "Upload prepared publish bundle",
);
assert(stageIndex >= 0 && uploadBundleIndex > stageIndex);
assert.equal(
  prepareJob.steps[uploadBundleIndex].with.name,
  `grammar-publish-bundle-\${{ github.run_attempt }}`,
);
assert.equal(prepareJob.steps[uploadBundleIndex].with.overwrite, true);
assert.equal(
  prepareJob.steps[uploadBundleIndex].with["retention-days"],
  artifact.with["retention-days"],
  "grammar-publish-bundle must match grammar-candidate's retention window for retries",
);
assert.equal(
  verifyUploadStep.with["retention-days"],
  artifact.with["retention-days"],
  "grammar-verified-bundle must match grammar-candidate's retention window for retries",
);
assert.equal(
  verifyDiffsUploadStep.with["retention-days"],
  artifact.with["retention-days"],
  "grammar-verified-diffs must match grammar-candidate's retention window",
);
const prepareSnapshotsStep = prepareJob.steps.find(
  (step) => step.name === "Prepare repository snapshots",
);
assert.equal(
  prepareSnapshotsStep.env.REPO_PINS,
  `\${{ needs.resolve-base.outputs.repo_pins }}`,
  "prepare job must consume trusted repo_pins from resolve-base",
);
assert.match(
  prepareSnapshotsStep.run,
  /node scripts\/prepare-grammar-update\.mjs --repo-pins "\$REPO_PINS" --output-dir "\$CANDIDATE"/,
);
assert.match(
  prepareJob.steps[stageIndex].run,
  /node scripts\/materialize-assets\.mjs --metadata-only/,
  "prepare job must regenerate standard metadata identically to verify before staging bundle",
);
assert.match(
  prepareJob.steps[stageIndex].run,
  /write-grammar-update-report\.mjs --pre-publish/,
  "pre-publish candidate artifact report must not claim Bunny CDN verification already succeeded",
);
assert.doesNotMatch(
  publication.run,
  /write-grammar-update-report\.mjs --pre-publish/,
  "post-publish PR report must reflect completed Bunny CDN verification",
);
const requiredPrepareSteps = [
  "Validate and apply the candidate",
  "Verify native compatibility",
  "Verify grammar output agreement",
];
for (const name of requiredPrepareSteps) {
  const index = prepareJob.steps.findIndex((step) => step.name === name);
  assert(index >= 0 && index < stageIndex, name);
  assert.equal(prepareJob.steps[index].if, "steps.prepare.outputs.changed == 'true'", name);
}
const restoreIndex = publishJob.steps.findIndex(
  (step) => step.name === "Restore verified candidate files",
);
const preflightIndex = publishJob.steps.findIndex(
  (step) => step.name === "Verify update target before publication",
);
const cdnUploadIndex = publishJob.steps.findIndex(
  (step) => step.name === "Publish immutable source and payload objects",
);
const publicationIndex = publishJob.steps.indexOf(publication);
assert(
  restoreIndex >= 0 &&
    preflightIndex > restoreIndex &&
    cdnUploadIndex > preflightIndex &&
    publicationIndex > cdnUploadIndex,
);
const downloadVerifiedStep = publishJob.steps.find(
  (step) => step.name === "Download verified publish bundle",
);
assert.equal(
  downloadVerifiedStep.with.name,
  `\${{ needs.verify.outputs.bundle_artifact }}`,
  "publish job must download the independently verified attempt-scoped bundle from verify",
);
assert.equal(
  publishJob.steps[restoreIndex].env.BUNDLE_SHA256,
  `\${{ needs.verify.outputs.bundle_sha256 }}`,
  "publish job must receive the verified bundle SHA-256 from verify",
);
assert.match(
  publishJob.steps[restoreIndex].run,
  /sha256sum -c -/,
  "publish job must verify bundle.tar.gz SHA-256 before extracting",
);
assert.match(
  publishJob.steps[restoreIndex].run,
  /node scripts\/publish-assets\.mjs --check --base-asset-catalog "\$base_asset_catalog"/,
  "publish job must verify restored theme lock against BASE_SHA before Bunny upload",
);
assert.equal(
  publishJob.steps[restoreIndex].env.REPO_PINS,
  `\${{ needs.resolve-base.outputs.repo_pins }}`,
  "publish job must receive trusted repo_pins from resolve-base",
);
assert.match(
  publishJob.steps[restoreIndex].run,
  /node scripts\/write-grammar-notices\.mjs --check --base-catalog "\$base_catalog" --base-sources "\$base_sources" --repo-pins "\$REPO_PINS" --verify-linguist-modules --verify-upstream-pins/,
  "publish job must verify restored grammar licenses, base catalog primary selections, resolve-base repo pins, Linguist module gitlinks, and pinned upstream blobs before Bunny upload",
);
assert.match(
  publishJob.steps[restoreIndex].run,
  /node scripts\/write-grammar-update-report\.mjs --check-locks --base-sources "\$base_sources" --base-catalog "\$base_catalog" --sources assets\/grammars\/sources\.json --catalog assets\/grammars\/catalog\.json "\$CANDIDATE\/report\.json"/,
  "publish job must verify report.json against base and candidate locks before Bunny upload",
);
const preflight = publishJob.steps[preflightIndex];
assert.equal(preflight.env.GH_TOKEN, `\${{ secrets.GITHUB_TOKEN }}`);
assert.equal(preflight.env.BASE_SHA, `\${{ needs.resolve-base.outputs.sha }}`);
assert.equal(
  preflight.env.EXPECTED_UPDATE_SHA,
  `\${{ needs.resolve-base.outputs.expected_update_sha }}`,
);

// Exercise the actual publication shell with real local Git repositories.
// GitHub is mocked; every origin points at the disposable local bare repository.
const temporary = await mkdtemp(path.join(tmpdir(), "ferriki-grammar-workflow-"));
const origin = path.join(temporary, "origin.git");
const mockBin = path.join(temporary, "bin");
const branch = publishJob.env.UPDATE_BRANCH;
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
const baseEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function run(command, args, cwd, env = baseEnv) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}
function git(args, cwd) {
  return run("git", args, cwd);
}
const realGit = run("which", ["git"]);
const remoteTip = () => git(["rev-parse", `refs/heads/${branch}`], origin);
let iteration = 0;
async function runner(generation, existing = true, raceDirectory, expectedUpdateSha, baseSha) {
  const directory = path.join(temporary, `runner-${++iteration}`);
  git(["clone", "--quiet", origin, directory]);
  await writeFile(path.join(directory, "assets/grammars/sources.json"), `${generation}\n`);
  await writeFile(path.join(directory, "assets/catalog.json"), `${generation}\n`);
  await writeFile(path.join(directory, "unrelated.txt"), "Do not commit this file.\n");
  const candidate = path.join(directory, "candidate");
  await mkdir(candidate);
  await writeFile(
    path.join(candidate, "report.json"),
    JSON.stringify({
      grammar_count: 1,
      changes: [],
      repositories: {},
      external_scopes: [],
    }),
  );
  const log = path.join(directory, "gh.log");
  const stepEnv = {
    ...baseEnv,
    PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
    GH_TOKEN: "ghs_fixture_test_token",
    CANDIDATE: candidate,
    DEFAULT_BRANCH: "main",
    UPDATE_BRANCH: branch,
    DIFFS_ARTIFACT: "grammar-verified-diffs-2",
    ...(baseSha !== undefined ? { BASE_SHA: baseSha } : {}),
    ...(expectedUpdateSha !== undefined ? { EXPECTED_UPDATE_SHA: expectedUpdateSha } : {}),
    GRAMMAR_TEST_GH_LOG: log,
    GRAMMAR_TEST_EXISTING_PR: existing ? "https://github.invalid/pull/1" : "",
    GRAMMAR_TEST_REAL_GIT: realGit,
    GRAMMAR_TEST_RACE_DIRECTORY: raceDirectory ?? "",
    GIT_AUTHOR_DATE: `2026-10-12T06:0${iteration}:00Z`,
    GIT_COMMITTER_DATE: `2026-10-12T06:0${iteration}:00Z`,
  };
  const preflightResult = spawnSync("bash", ["-e", "-o", "pipefail", "-c", preflight.run], {
    cwd: directory,
    encoding: "utf8",
    env: stepEnv,
  });
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", publication.run], {
    cwd: directory,
    encoding: "utf8",
    env: stepEnv,
  });
  const gitConfig = await readFile(path.join(directory, ".git/config"), "utf8");
  assert.doesNotMatch(
    gitConfig,
    /extraheader|ghs_fixture_test_token/i,
    "publication step must not persist git credentials into .git/config",
  );
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { ...result, preflightStatus: preflightResult.status, preflightStderr: preflightResult.stderr, calls };
}

try {
  await mkdir(mockBin);
  await writeFile(
    path.join(mockBin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GRAMMAR_TEST_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "pr" || !["list", "edit", "create"].includes(args[1])) process.exit(2);
if (args[1] === "list") process.stdout.write(process.env.GRAMMAR_TEST_EXISTING_PR + "\\n");
`,
  );
  await writeFile(
    path.join(mockBin, "git"),
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const git = process.env.GRAMMAR_TEST_REAL_GIT;
const race = process.env.GRAMMAR_TEST_RACE_DIRECTORY;
if (args[0] === "push" && race) {
  const advance = spawnSync(git, ["push", "--force-with-lease", "origin", "HEAD:refs/heads/" + process.env.UPDATE_BRANCH], {cwd: race});
  if (advance.status !== 0) process.exit(advance.status || 1);
}
const result = spawnSync(git, args, {stdio: "inherit"});
process.exit(result.status ?? 1);
`,
  );
  for (const file of ["git", "gh"]) await chmod(path.join(mockBin, file), 0o755);
  git(["init", "--bare", "--initial-branch=main", origin]);
  const seed = path.join(temporary, "seed");
  git(["clone", "--quiet", origin, seed]);
  for (const directory of [
    "assets/grammars",
    "assets/upstream/curated",
    "assets/standard",
    "scripts",
  ])
    await mkdir(path.join(seed, directory), { recursive: true });
  for (const file of [
    "assets/grammars/sources.json",
    "assets/upstream/curated/example.json",
    "assets/catalog.json",
    "assets/standard/example.fkgram",
  ])
    await writeFile(path.join(seed, file), "0\n");
  await copyFile(
    new URL("./write-grammar-update-report.mjs", import.meta.url),
    path.join(seed, "scripts/write-grammar-update-report.mjs"),
  );
  git(["config", "user.name", "Fixture maintainer"], seed);
  git(["config", "user.email", "maintainer@example.invalid"], seed);
  git(["add", "."], seed);
  git(["commit", "-m", "chore: seed fixture"], seed);
  git(["push", "origin", "main"], seed);

  const initialMainTip = git(["rev-parse", "refs/heads/main"], origin);
  const first = await runner(1, false, undefined, "", initialMainTip);
  assert.equal(first.preflightStatus, 0, first.preflightStderr);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(
    first.calls.map((call) => call[1]),
    ["list", "create"],
  );
  assert(first.calls[1].includes("--draft"));
  const postPublishReport = await readFile(
    path.join(temporary, "runner-1", "candidate", "report.md"),
    "utf8",
  );
  assert.match(postPublishReport, /and immutable Bunny Storage upload\/read-back verification\./);
  assert.match(postPublishReport, /`grammar-verified-diffs-2`/);
  const prePublishReportPath = path.join(temporary, "pre-publish-report.md");
  run(
    process.execPath,
    [
      path.join(seed, "scripts/write-grammar-update-report.mjs"),
      "--pre-publish",
      path.join(temporary, "runner-1", "candidate", "report.json"),
      prePublishReportPath,
    ],
    temporary,
  );
  const prePublishReport = await readFile(prePublishReportPath, "utf8");
  assert.doesNotMatch(
    prePublishReport,
    /and immutable Bunny Storage upload\/read-back verification\./,
  );
  assert.match(prePublishReport, /run in separate jobs/);
  assert.equal(git(["show", `${branch}:assets/grammars/sources.json`], origin), "1");
  assert(!git(["ls-tree", "-r", "--name-only", branch], origin).includes("unrelated.txt"));
  const firstTip = remoteTip();

  // Missing or empty BASE_SHA must fail closed in both preflight and publication.
  const missingBase = await runner(1, true, undefined, firstTip, "");
  assert.notEqual(missingBase.preflightStatus, 0, "Preflight must fail closed when BASE_SHA is empty");
  assert.match(missingBase.preflightStderr, /Missing or invalid resolved base commit SHA/);
  assert.notEqual(missingBase.status, 0, "Publication must fail closed when BASE_SHA is empty");
  assert.match(missingBase.stderr, /Missing or invalid resolved base commit SHA/);

  const identical = await runner(1, true, undefined, undefined, initialMainTip);
  assert.equal(identical.status, 0, identical.stderr);
  assert.equal(remoteTip(), firstTip, "An identical tree must not be pushed again");
  assert.deepEqual(
    identical.calls.map((call) => call[1]),
    ["list", "edit"],
  );

  const newer = await runner(2, true, undefined, firstTip, initialMainTip);
  assert.equal(newer.preflightStatus, 0, newer.preflightStderr);
  assert.equal(newer.status, 0, newer.stderr);
  const newerTip = remoteTip();
  assert.notEqual(newerTip, firstTip);
  assert.equal(git(["show", `${branch}:assets/grammars/sources.json`], origin), "2");
  assert.deepEqual(
    newer.calls.map((call) => call[1]),
    ["list", "edit"],
  );

  // A retried older publish job whose resolved expected tip is stale must not
  // upload to Bunny Storage or overwrite the newer update branch when the
  // candidate tree differs.
  const staleRetry = await runner(1, true, undefined, firstTip, initialMainTip);
  assert.notEqual(
    staleRetry.preflightStatus,
    0,
    "Pre-upload check must reject a stale retried publish before Bunny upload",
  );
  assert.match(staleRetry.preflightStderr, /moved from/);
  assert.notEqual(staleRetry.status, 0, "A stale retried publish must not overwrite a newer update");
  assert.match(staleRetry.stderr, /moved from/);
  assert.equal(remoteTip(), newerTip);
  assert.equal(git(["show", `${branch}:assets/grammars/sources.json`], origin), "2");
  assert.deepEqual(
    staleRetry.calls.map((call) => call[1]),
    ["list"],
  );

  // Retrying the same publish job after its push already landed stays idempotent
  // when the remote branch already holds the exact same candidate tree.
  const idempotentRetry = await runner(2, true, undefined, firstTip, initialMainTip);
  assert.equal(idempotentRetry.preflightStatus, 0, idempotentRetry.preflightStderr);
  assert.equal(idempotentRetry.status, 0, idempotentRetry.stderr);
  assert.equal(remoteTip(), newerTip);
  assert.deepEqual(
    idempotentRetry.calls.map((call) => call[1]),
    ["list", "edit"],
  );

  const race = path.join(temporary, "race");
  git(["clone", "--quiet", "--branch", branch, origin, race]);
  git(["config", "user.name", "Fixture maintainer"], race);
  git(["config", "user.email", "maintainer@example.invalid"], race);
  await writeFile(path.join(race, "manual.txt"), "Preserve concurrent work.\n");
  git(["add", "manual.txt"], race);
  git(["commit", "--amend", "--no-edit"], race);
  assert.equal(git(["log", "-1", "--format=%ae"], race), botEmail);
  assert.equal(git(["log", "-1", "--format=%ce"], race), "maintainer@example.invalid");
  const manualTip = git(["rev-parse", "HEAD"], race);
  const concurrent = await runner(3, true, race, undefined, initialMainTip);
  assert.notEqual(concurrent.status, 0, "A concurrent update must reject the push lease");
  assert.equal(remoteTip(), manualTip);
  assert.deepEqual(
    concurrent.calls.map((call) => call[1]),
    ["list"],
  );

  const manual = await runner(4, true, undefined, undefined, initialMainTip);
  assert.notEqual(manual.status, 0, "A manual commit must stop automatic replacement");
  assert.match(manual.stderr, /manual commit/);
  assert.equal(remoteTip(), manualTip);
  assert.deepEqual(
    manual.calls.map((call) => call[1]),
    ["list"],
  );
  assert.equal(git(["log", "-1", "--format=%ae", firstTip], origin), botEmail);

  // If main advanced while the update branch still exists (for example, a PR
  // was merged without deleting the bot branch), both pre-upload verification
  // and publication must abort rather than replacing the branch from a stale base.
  await writeFile(path.join(seed, "assets/catalog.json"), "merged-keep-branch\n");
  git(["add", "assets/catalog.json"], seed);
  git(["commit", "-m", "chore: merge grammar update keeping branch"], seed);
  git(["push", "origin", "main"], seed);
  const movedMainExistingBranch = await runner(5, true, undefined, manualTip, initialMainTip);
  // Note: manualTip has a manual commit, so also verify with a bot-authored tip.
  assert.notEqual(movedMainExistingBranch.preflightStatus, 0);
  git(["update-ref", `refs/heads/${branch}`, newerTip], origin);
  const existingBranchStaleMain = await runner(5, true, undefined, newerTip, initialMainTip);
  assert.notEqual(
    existingBranchStaleMain.preflightStatus,
    0,
    "Pre-upload check must reject a stale default-branch base even when the update branch exists",
  );
  assert.match(existingBranchStaleMain.preflightStderr, /default branch moved from/);
  assert.notEqual(
    existingBranchStaleMain.status,
    0,
    "Publication must reject a stale default-branch base even when the update branch exists",
  );
  assert.match(existingBranchStaleMain.stderr, /default branch moved from/);
  assert.equal(remoteTip(), newerTip);
  assert.deepEqual(
    existingBranchStaleMain.calls.map((call) => call[1]),
    ["list"],
  );

  // Even when the candidate tree matches FETCH_HEAD (e.g. a merged PR whose
  // bot branch was retained), a stale default-branch base must abort before
  // Bunny upload and before editing/reopening a PR.
  const identicalTreeStaleMain = await runner(2, true, undefined, newerTip, initialMainTip);
  assert.notEqual(
    identicalTreeStaleMain.preflightStatus,
    0,
    "Pre-upload check must reject a stale default-branch base even when candidate tree matches FETCH_HEAD",
  );
  assert.match(identicalTreeStaleMain.preflightStderr, /default branch moved from/);
  assert.notEqual(
    identicalTreeStaleMain.status,
    0,
    "Publication must reject a stale default-branch base even when candidate tree matches FETCH_HEAD",
  );
  assert.match(identicalTreeStaleMain.stderr, /default branch moved from/);
  assert.equal(remoteTip(), newerTip);
  assert.deepEqual(
    identicalTreeStaleMain.calls.map((call) => call[1]),
    ["list"],
  );

  // If the update branch was also deleted after main advanced, retrying an
  // older publish job whose resolve-base saw an absent branch and an older
  // main SHA must abort before upload and before recreating the branch.
  git(["branch", "-D", branch], origin);
  const recreatedFromStaleBase = await runner(1, false, undefined, "", initialMainTip);
  assert.notEqual(
    recreatedFromStaleBase.preflightStatus,
    0,
    "Pre-upload check must reject recreating a deleted branch from a stale base",
  );
  assert.match(recreatedFromStaleBase.preflightStderr, /default branch moved from/);
  assert.notEqual(
    recreatedFromStaleBase.status,
    0,
    "A stale retry must not recreate a deleted update branch after main advanced",
  );
  assert.match(recreatedFromStaleBase.stderr, /default branch moved from/);
  assert.equal(
    git(["ls-remote", "--heads", origin, `refs/heads/${branch}`], temporary),
    "",
    "The deleted update branch must remain absent after a stale retry aborts",
  );
  assert.deepEqual(
    recreatedFromStaleBase.calls.map((call) => call[1]),
    ["list"],
  );

  // Verify write-grammar-notices.mjs --check validates restored license files
  // and fails on missing, corrupted, invalid-path, or unreferenced license files.
  const licenseFixture = path.join(temporary, "license-fixture");
  await mkdir(path.join(licenseFixture, "assets/grammars/licenses"), { recursive: true });
  await mkdir(path.join(licenseFixture, "assets/grammars/local"), { recursive: true });
  await mkdir(path.join(licenseFixture, "assets/standard"), { recursive: true });
  await mkdir(path.join(licenseFixture, "node/ferriki/scripts"), { recursive: true });
  await mkdir(path.join(licenseFixture, "scripts"), { recursive: true });
  const noticesScript = path.join(licenseFixture, "scripts/write-grammar-notices.mjs");
  for (const [src, dst] of [
    ["./write-grammar-notices.mjs", "scripts/write-grammar-notices.mjs"],
    ["./local-grammar.mjs", "scripts/local-grammar.mjs"],
    ["./asset-store.mjs", "scripts/asset-store.mjs"],
    ["../node/ferriki/scripts/asset-path.mjs", "node/ferriki/scripts/asset-path.mjs"],
  ])
    await copyFile(new URL(src, import.meta.url), path.join(licenseFixture, dst));
  const licenseText = "MIT License\n";
  const { createHash } = await import("node:crypto");
  const licenseHash = createHash("sha256").update(licenseText).digest("hex");
  const licenseRelPath = `assets/grammars/licenses/${licenseHash}.txt`;
  const localGrammarText = '{"scopeName":"source.demo"}\n';
  const localGrammarHash = createHash("sha256").update(localGrammarText).digest("hex");
  const localGrammarRelPath = "assets/grammars/local/demo.tmLanguage.json";
  await writeFile(path.join(licenseFixture, "LICENSE-MIT"), licenseText);
  await writeFile(path.join(licenseFixture, localGrammarRelPath), localGrammarText);
  const validSources = {
    version: 2,
    repositories: {
      vscode: {
        repository: "example/repo",
        ref: "main",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
    languages: [
      {
        id: "example",
        grammar_file: "example.json",
        scope_name: "source.example",
        display_name: "Example",
        aliases: [],
        embedded_langs: [],
        embedded_langs_lazy: [],
        inject_to: [],
        repository_id: "vscode",
        upstream_repository: "example/repo",
        upstream_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        upstream_path: "example.json",
        source: "https://raw.githubusercontent.com/example/repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/example.json",
        license: "MIT",
        license_url: "https://raw.githubusercontent.com/example/repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/LICENSE",
        license_file: licenseRelPath,
      },
      {
        id: "demo",
        grammar_file: "demo.json",
        scope_name: "source.demo",
        display_name: "Demo",
        aliases: [],
        embedded_langs: [],
        embedded_langs_lazy: [],
        inject_to: [],
        repository_id: "local",
        upstream_path: localGrammarRelPath,
        upstream_sha256: localGrammarHash,
        source: localGrammarRelPath,
        license: "MIT",
        license_url: "LICENSE-MIT",
        license_file: licenseRelPath,
      },
    ],
  };
  const validCatalog = {
    version: 1,
    languages: [
      {
        id: "example",
        role: "standard",
        grammar_file: "example.json",
        scope_name: "source.example",
        display_name: "Example",
        aliases: [],
        embedded_langs: [],
        embedded_langs_lazy: [],
        inject_to: [],
        repository_id: "vscode",
        selector: { path: "example.json" },
      },
      {
        id: "demo",
        role: "standard",
        grammar_file: "demo.json",
        scope_name: "source.demo",
        display_name: "Demo",
        aliases: [],
        embedded_langs: [],
        embedded_langs_lazy: [],
        inject_to: [],
        repository_id: "local",
        selector: { path: localGrammarRelPath },
      },
    ],
  };
  const validRepositories = {
    version: 1,
    repositories: [
      {
        id: "vscode",
        repository: "example/repo",
        ref: "main",
        license: {
          id: "MIT",
          path: "LICENSE",
        },
      },
    ],
  };
  const baseCatalogFile = path.join(temporary, "base-catalog.json");
  await writeFile(baseCatalogFile, JSON.stringify(validCatalog, null, 2));
  await writeFile(
    path.join(licenseFixture, "assets/grammars/repositories.json"),
    JSON.stringify(validRepositories, null, 2),
  );
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(validSources, null, 2),
  );
  await writeFile(
    path.join(licenseFixture, "assets/grammars/catalog.json"),
    JSON.stringify(validCatalog, null, 2),
  );
  await writeFile(path.join(licenseFixture, licenseRelPath), licenseText);
  run(process.execPath, [noticesScript], licenseFixture);
  run(
    process.execPath,
    [noticesScript, "--check", "--base-catalog", baseCatalogFile],
    licenseFixture,
  );

  // Dropping a primary language from restored catalog.json must fail --base-catalog.
  await writeFile(
    path.join(licenseFixture, "assets/grammars/catalog.json"),
    JSON.stringify({ version: 1, languages: [validCatalog.languages[1]] }, null, 2),
  );
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify({ ...validSources, languages: [validSources.languages[1]] }, null, 2),
  );
  const droppedPrimary = spawnSync(
    process.execPath,
    [noticesScript, "--check", "--base-catalog", baseCatalogFile],
    { cwd: licenseFixture, encoding: "utf8" },
  );
  assert.notEqual(
    droppedPrimary.status,
    0,
    "Dropping a primary language from catalog.json must fail --base-catalog verification",
  );
  assert.match(droppedPrimary.stderr, /Primary grammar catalog selection drift/);
  await writeFile(
    path.join(licenseFixture, "assets/grammars/catalog.json"),
    JSON.stringify(validCatalog, null, 2),
  );
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(validSources, null, 2),
  );

  // Mislabeled license ID (e.g. Apache-2.0 when repositories.json configures MIT) must fail --check.
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(
      {
        ...validSources,
        languages: [
          { ...validSources.languages[0], license: "Apache-2.0" },
          validSources.languages[1],
        ],
      },
      null,
      2,
    ),
  );
  const wrongLicenseId = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(wrongLicenseId.status, 0, "Mislabeled license ID must fail verification");
  assert.match(wrongLicenseId.stderr, /Grammar license ID drift/);

  // Wrong license_url (pointing at a different file than repositories.json) must fail --check.
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(
      {
        ...validSources,
        languages: [
          {
            ...validSources.languages[0],
            license_url:
              "https://raw.githubusercontent.com/example/repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/OTHER-LICENSE",
          },
          validSources.languages[1],
        ],
      },
      null,
      2,
    ),
  );
  const wrongLicenseUrl = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(wrongLicenseUrl.status, 0, "Wrong license_url must fail verification");
  assert.match(wrongLicenseUrl.stderr, /Grammar license URL drift/);
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(validSources, null, 2),
  );

  // Verify verifyLinguistModules follows same-host 301 redirects (github/linguist ->
  // github-linguist/linguist), rejects cross-origin redirects, and rejects pin drift.
  const {
    fetchPinnedGithub,
    resolveRepositoryPins,
    verifyLinguistModules,
    verifyUpstreamBlobs,
  } = await import(
    new URL("./write-grammar-notices.mjs", import.meta.url).href
  );
  const mockLinguistFetch = async (url) => {
    if (url.includes("/repos/github/linguist/git/trees/")) {
      return {
        status: 301,
        ok: false,
        headers: new Headers({
          location: url.replace("/repos/github/linguist/", "/repos/github-linguist/linguist/"),
        }),
      };
    }
    if (url.includes("/repos/github-linguist/linguist/git/trees/")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          truncated: false,
          tree: [
            {
              path: "vendor/grammars/graphiql",
              type: "commit",
              sha: "cccccccccccccccccccccccccccccccccccccccc",
            },
          ],
        }),
      };
    }
    if (url.includes("/github/linguist/")) {
      return {
        status: 301,
        ok: false,
        headers: new Headers({
          location: url.replace("/github/linguist/", "/github-linguist/linguist/"),
        }),
      };
    }
    return {
      status: 200,
      ok: true,
      text: async () =>
        '[submodule "vendor/grammars/graphiql"]\n  path = vendor/grammars/graphiql\n  url = https://github.com/graphql/graphiql.git\n',
    };
  };
  await verifyLinguistModules({
    snapshot: {
      repository: "github/linguist",
      commit: "dddddddddddddddddddddddddddddddddddddddd",
      modules: {
        "vendor/grammars/graphiql": {
          repository: "graphql/graphiql",
          commit: "cccccccccccccccccccccccccccccccccccccccc",
        },
      },
    },
    expectedModules: new Set(["vendor/grammars/graphiql"]),
    fetchImpl: mockLinguistFetch,
  });
  await assert.rejects(
    fetchPinnedGithub("https://api.github.com/repos/github/linguist/git/trees/deadbeef", {
      allowedHosts: ["api.github.com"],
      fetchImpl: async () => ({
        status: 302,
        ok: false,
        headers: new Headers({ location: "https://evil.example/tree" }),
      }),
    }),
    /Disallowed redirect target/,
  );
  // Same-host redirect to a non-default port must be rejected without leaking Authorization.
  const portRedirectRequests = [];
  await assert.rejects(
    fetchPinnedGithub("https://raw.githubusercontent.com/org/repo/commit/file.json", {
      allowedHosts: ["raw.githubusercontent.com"],
      headers: { Authorization: "Bearer ghs_secret_token" },
      fetchImpl: async (url, options) => {
        portRedirectRequests.push({ url, headers: options.headers });
        return {
          status: 302,
          ok: false,
          headers: new Headers({
            location: "https://raw.githubusercontent.com:8443/org/repo/commit/file.json",
          }),
        };
      },
    }),
    /Disallowed redirect target/,
  );
  assert.equal(
    portRedirectRequests.length,
    1,
    "Non-default port redirect must be rejected before issuing a second request",
  );
  // Cross-origin redirect between two allowlisted hosts must strip Authorization.
  const crossOriginHeaders = [];
  const crossOriginResponse = await fetchPinnedGithub(
    "https://api.github.com/repos/org/repo/file",
    {
      allowedHosts: ["api.github.com", "raw.githubusercontent.com"],
      headers: { Authorization: "Bearer ghs_secret_token" },
      fetchImpl: async (url, options) => {
        crossOriginHeaders.push({ url, headers: options.headers });
        if (url.startsWith("https://api.github.com/")) {
          return {
            status: 302,
            ok: false,
            headers: new Headers({
              location: "https://raw.githubusercontent.com/org/repo/commit/file",
            }),
          };
        }
        return { status: 200, ok: true };
      },
    },
  );
  assert.equal(crossOriginResponse.ok, true);
  assert.equal(crossOriginHeaders.length, 2);
  assert.equal(crossOriginHeaders[0].headers.Authorization, "Bearer ghs_secret_token");
  assert.equal(
    crossOriginHeaders[1].headers.Authorization,
    undefined,
    "Cross-origin redirect must strip Authorization header",
  );
  await assert.rejects(
    verifyLinguistModules({
      snapshot: {
        repository: "github/linguist",
        commit: "dddddddddddddddddddddddddddddddddddddddd",
        modules: {
          "vendor/grammars/graphiql": {
            repository: "attacker/graphiql",
            commit: "cccccccccccccccccccccccccccccccccccccccc",
          },
        },
      },
      expectedModules: new Set(["vendor/grammars/graphiql"]),
      fetchImpl: mockLinguistFetch,
    }),
    /Linguist module pin drift/,
  );
  // Oversized streamed .gitmodules (without Content-Length) must abort early before buffering.
  let gitmodulesChunksPulled = 0;
  let gitmodulesCancelled = false;
  const gitmodulesOneMiB = new Uint8Array(1024 * 1024);
  await assert.rejects(
    verifyLinguistModules({
      snapshot: {
        repository: "github-linguist/linguist",
        commit: "dddddddddddddddddddddddddddddddddddddddd",
        modules: {
          "vendor/grammars/graphiql": {
            repository: "graphql/graphiql",
            commit: "cccccccccccccccccccccccccccccccccccccccc",
          },
        },
      },
      expectedModules: new Set(["vendor/grammars/graphiql"]),
      fetchImpl: async (url) => {
        if (url.includes("/git/trees/")) {
          return mockLinguistFetch(url);
        }
        return {
          status: 200,
          ok: true,
          headers: new Headers(),
          body: new ReadableStream(
            {
              pull(controller) {
                gitmodulesChunksPulled += 1;
                if (gitmodulesChunksPulled > 20) {
                  controller.close();
                  return;
                }
                controller.enqueue(gitmodulesOneMiB);
              },
              cancel() {
                gitmodulesCancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
        };
      },
    }),
    /exceeds 8388608 bytes/,
  );
  assert.equal(gitmodulesCancelled, true, "Oversized .gitmodules stream must be cancelled");
  assert.equal(
    gitmodulesChunksPulled,
    9,
    "Oversized .gitmodules stream must stop immediately after crossing 8 MiB",
  );

  // Verify verifyUpstreamBlobs checks changed grammar source & license bytes
  // against pinned raw GitHub blobs and skips unchanged base entries.
  const rawBlob = Buffer.from('{"scopeName":"source.example"}\n');
  const rawBlobHash = createHash("sha256").update(rawBlob).digest("hex");
  const licenseBlob = Buffer.from(licenseText);
  const fetchedUrls = [];
  const mockUpstreamFetch = async (url) => {
    fetchedUrls.push(url);
    if (url.endsWith("/LICENSE")) {
      return { status: 200, ok: true, arrayBuffer: async () => licenseBlob };
    }
    return { status: 200, ok: true, arrayBuffer: async () => rawBlob };
  };
  const upstreamEntry = {
    ...validSources.languages[0],
    upstream_sha256: rawBlobHash,
  };
  await verifyUpstreamBlobs({
    sources: { languages: [upstreamEntry] },
    baseSources: { languages: [upstreamEntry] },
    fetchImpl: mockUpstreamFetch,
  });
  assert.equal(fetchedUrls.length, 0, "Unchanged entries should not trigger upstream fetches");
  await verifyUpstreamBlobs({
    sources: { languages: [upstreamEntry] },
    baseSources: { languages: [] },
    fetchImpl: mockUpstreamFetch,
  });
  assert.equal(fetchedUrls.length, 2, "Changed entry should fetch both source and license blobs");
  await assert.rejects(
    verifyUpstreamBlobs({
      sources: {
        languages: [{ ...upstreamEntry, upstream_sha256: "0".repeat(64) }],
      },
      baseSources: { languages: [] },
      fetchImpl: mockUpstreamFetch,
    }),
    /Upstream source digest mismatch/,
  );
  await assert.rejects(
    verifyUpstreamBlobs({
      sources: {
        languages: [
          { ...upstreamEntry, license_file: `assets/grammars/licenses/${"0".repeat(64)}.txt` },
        ],
      },
      baseSources: { languages: [] },
      fetchImpl: mockUpstreamFetch,
    }),
    /Upstream license digest mismatch/,
  );

  // Streaming >8 MiB response must abort early without reading the entire body.
  let chunksPulled = 0;
  let streamCancelled = false;
  const oneMiB = new Uint8Array(1024 * 1024);
  const oversizedStreamFetch = async () => ({
    status: 200,
    ok: true,
    headers: new Headers(),
    body: new ReadableStream(
      {
        pull(controller) {
          chunksPulled += 1;
          if (chunksPulled > 20) {
            controller.close();
            return;
          }
          controller.enqueue(oneMiB);
        },
        cancel() {
          streamCancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  });
  await assert.rejects(
    verifyUpstreamBlobs({
      sources: { languages: [upstreamEntry] },
      baseSources: { languages: [] },
      fetchImpl: oversizedStreamFetch,
    }),
    /exceeds 8388608 bytes/,
  );
  assert.equal(streamCancelled, true, "Oversized upstream stream must be cancelled immediately");
  assert.equal(
    chunksPulled,
    9,
    "Oversized upstream stream must stop immediately after crossing 8 MiB (chunk 9 of 20)",
  );

  // Oversized Content-Length header must reject before pulling any stream chunk.
  let clChunksPulled = 0;
  let clCancelled = false;
  await assert.rejects(
    verifyUpstreamBlobs({
      sources: { languages: [upstreamEntry] },
      baseSources: { languages: [] },
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ "content-length": String(9 * 1024 * 1024) }),
        body: new ReadableStream(
          {
            pull(controller) {
              clChunksPulled += 1;
              controller.enqueue(oneMiB);
            },
            cancel() {
              clCancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      }),
    }),
    /exceeds 8388608 bytes/,
  );
  assert.equal(clChunksPulled, 0, "Oversized Content-Length must reject before reading body");
  assert.equal(clCancelled, true, "Oversized Content-Length must cancel body stream");

  // Verify resolveRepositoryPins resolves configured refs (following 301 redirects)
  // and write-grammar-notices.mjs --check --repo-pins enforces strict pin equality.
  const resolvedPins = await resolveRepositoryPins({
    config: {
      repositories: [
        { id: "vscode", repository: "microsoft/vscode", ref: "main" },
        { id: "linguist", repository: "github/linguist", ref: "main" },
      ],
    },
    fetchImpl: async (url) => {
      if (url.includes("/repos/github/linguist/")) {
        return {
          status: 301,
          ok: false,
          headers: new Headers({
            location: url.replace("/repos/github/linguist/", "/repos/github-linguist/linguist/"),
          }),
        };
      }
      if (url.includes("/repos/github-linguist/linguist/commits/main")) {
        return { status: 200, ok: true, json: async () => ({ sha: "d".repeat(40) }) };
      }
      if (url.includes("/repos/microsoft/vscode/commits/main")) {
        return { status: 200, ok: true, json: async () => ({ sha: "a".repeat(40) }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.deepEqual(resolvedPins, { vscode: "a".repeat(40), linguist: "d".repeat(40) });

  run(
    process.execPath,
    [noticesScript, "--check", "--repo-pins", JSON.stringify({ vscode: "a".repeat(40) })],
    licenseFixture,
  );
  const driftedResolveBasePin = spawnSync(
    process.execPath,
    [noticesScript, "--check", "--repo-pins", JSON.stringify({ vscode: "e".repeat(40) })],
    { cwd: licenseFixture, encoding: "utf8" },
  );
  assert.notEqual(
    driftedResolveBasePin.status,
    0,
    "sources.json commit differing from resolve-base repo_pins must fail --check --repo-pins",
  );
  assert.match(driftedResolveBasePin.stderr, /Grammar repository pin drift against resolve-base/);

  // Explicitly passing an empty --repo-pins value must fail closed rather than silently skipping pin checks.
  for (const emptyArgs of [
    [noticesScript, "--check", "--repo-pins", ""],
    [noticesScript, "--check", "--repo-pins="],
  ]) {
    const emptyPinsNotice = spawnSync(process.execPath, emptyArgs, {
      cwd: licenseFixture,
      encoding: "utf8",
    });
    assert.notEqual(
      emptyPinsNotice.status,
      0,
      `Empty --repo-pins (${emptyArgs.slice(2).join(" ")}) must fail write-grammar-notices --check`,
    );
    assert.match(emptyPinsNotice.stderr, /Empty --repo-pins value/);
  }
  const prepareScript = fileURLToPath(new URL("./prepare-grammar-update.mjs", import.meta.url));
  for (const emptyArgs of [
    [prepareScript, "--repo-pins", "", "--output-dir", path.join(temporary, "empty-pins-1")],
    [prepareScript, "--repo-pins=", "--output-dir", path.join(temporary, "empty-pins-2")],
  ]) {
    const emptyPinsPrepare = spawnSync(process.execPath, emptyArgs, {
      cwd: temporary,
      encoding: "utf8",
    });
    assert.notEqual(
      emptyPinsPrepare.status,
      0,
      `Empty --repo-pins (${emptyArgs.slice(1, 3).join(" ")}) must fail prepare-grammar-update`,
    );
    assert.match(emptyPinsPrepare.stderr, /Empty --repo-pins value/);
  }

  // Verify Linguist module without a module_licenses override inherits repo-level license.
  const linguistFixture = path.join(temporary, "linguist-fallback-fixture");
  for (const dir of ["assets/grammars/licenses", "assets/standard", "scripts"])
    await mkdir(path.join(linguistFixture, dir), { recursive: true });
  for (const [src, dst] of [
    ["./write-grammar-notices.mjs", "scripts/write-grammar-notices.mjs"],
    ["./local-grammar.mjs", "scripts/local-grammar.mjs"],
    ["./asset-store.mjs", "scripts/asset-store.mjs"],
    ["../node/ferriki/scripts/asset-path.mjs", "node/ferriki/scripts/asset-path.mjs"],
  ]) {
    await mkdir(path.dirname(path.join(linguistFixture, dst)), { recursive: true });
    await copyFile(new URL(src, import.meta.url), path.join(linguistFixture, dst));
  }
  await writeFile(path.join(linguistFixture, licenseRelPath), licenseText);
  await writeFile(
    path.join(linguistFixture, "assets/grammars/repositories.json"),
    JSON.stringify(
      {
        version: 1,
        repositories: [
          {
            id: "linguist",
            repository: "github/linguist",
            ref: "main",
            adapter: "linguist",
            modules: ["vendor/grammars/sample"],
            license: { id: "MIT", path: "LICENSE" },
            module_licenses: {},
          },
        ],
      },
      null,
      2,
    ),
  );
  const linguistModCommit = "c".repeat(40);
  await writeFile(
    path.join(linguistFixture, "assets/grammars/catalog.json"),
    JSON.stringify(
      {
        version: 1,
        languages: [
          {
            id: "sample",
            grammar_file: "sample.json",
            scope_name: "source.sample",
            display_name: "Sample",
            aliases: [],
            embedded_langs: [],
            embedded_langs_lazy: [],
            inject_to: [],
            role: "primary",
            repository_id: "linguist",
            selector: { module: "vendor/grammars/sample", scope: "source.sample" },
          },
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(linguistFixture, "assets/grammars/sources.json"),
    JSON.stringify(
      {
        version: 2,
        repositories: {
          linguist: {
            repository: "github/linguist",
            ref: "main",
            commit: "d".repeat(40),
            modules: {
              "vendor/grammars/sample": {
                repository: "example/sample-grammar",
                commit: linguistModCommit,
              },
            },
          },
        },
        languages: [
          {
            id: "sample",
            grammar_file: "sample.json",
            scope_name: "source.sample",
            display_name: "Sample",
            aliases: [],
            embedded_langs: [],
            embedded_langs_lazy: [],
            inject_to: [],
            role: "primary",
            repository_id: "linguist",
            module: "vendor/grammars/sample",
            upstream_repository: "example/sample-grammar",
            upstream_commit: linguistModCommit,
            upstream_path: "syntaxes/sample.tmLanguage.json",
            source: `https://raw.githubusercontent.com/example/sample-grammar/${linguistModCommit}/syntaxes/sample.tmLanguage.json`,
            license: "MIT",
            license_url: `https://raw.githubusercontent.com/example/sample-grammar/${linguistModCommit}/LICENSE`,
            license_file: licenseRelPath,
          },
        ],
      },
      null,
      2,
    ),
  );
  const linguistNoticesScript = path.join(linguistFixture, "scripts/write-grammar-notices.mjs");
  run(process.execPath, [linguistNoticesScript], linguistFixture);
  run(process.execPath, [linguistNoticesScript, "--check"], linguistFixture);

  // Drifted catalog.json must fail --check before Bunny upload.
  await writeFile(
    path.join(licenseFixture, "assets/grammars/catalog.json"),
    JSON.stringify(
      {
        ...validCatalog,
        languages: [
          { ...validCatalog.languages[0], aliases: ["ex"] },
          validCatalog.languages[1],
        ],
      },
      null,
      2,
    ),
  );
  const driftedCatalog = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(driftedCatalog.status, 0, "Drifted catalog.json must fail verification");
  assert.match(driftedCatalog.stderr, /Grammar catalog metadata drift/);
  await writeFile(
    path.join(licenseFixture, "assets/grammars/catalog.json"),
    JSON.stringify(validCatalog, null, 2),
  );

  // Stale upstream_commit disagreeing with repositories snapshot must fail --check.
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(
      {
        ...validSources,
        languages: [
          {
            ...validSources.languages[0],
            upstream_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
          validSources.languages[1],
        ],
      },
      null,
      2,
    ),
  );
  const staleCommit = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(staleCommit.status, 0, "Stale upstream_commit must fail verification");
  assert.match(staleCommit.stderr, /Grammar repository pin drift/);

  // Drifted repository slug in sources.json (disagreeing with repositories.json) must fail --check.
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(
      {
        ...validSources,
        repositories: {
          vscode: { ...validSources.repositories.vscode, repository: "attacker/evil-repo" },
        },
      },
      null,
      2,
    ),
  );
  const driftedRepoSlug = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(driftedRepoSlug.status, 0, "Drifted repository slug must fail verification");
  assert.match(driftedRepoSlug.stderr, /Grammar repository config drift/);
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(validSources, null, 2),
  );

  // Checked-out local grammar bytes differing from sources.json must fail --check.
  await writeFile(path.join(licenseFixture, localGrammarRelPath), '{"scopeName":"source.changed"}\n');
  const localDrift = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(localDrift.status, 0, "Mismatched local grammar bytes must fail verification");
  assert.match(localDrift.stderr, /Local grammar digest mismatch/);
  await writeFile(path.join(licenseFixture, localGrammarRelPath), localGrammarText);

  // Changed selector.path in catalog.json must fail --check.
  await writeFile(
    path.join(licenseFixture, "assets/grammars/catalog.json"),
    JSON.stringify(
      {
        ...validCatalog,
        languages: [
          { ...validCatalog.languages[0], selector: { path: "other.json" } },
          validCatalog.languages[1],
        ],
      },
      null,
      2,
    ),
  );
  const driftedSelector = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(driftedSelector.status, 0, "Drifted selector.path must fail verification");
  assert.match(driftedSelector.stderr, /Grammar catalog selector path drift/);
  await writeFile(
    path.join(licenseFixture, "assets/grammars/catalog.json"),
    JSON.stringify(validCatalog, null, 2),
  );

  // Invalid UTF-8 in a license file (even with matching SHA-256 filename) must fail.
  const badUtf8 = Buffer.from([0xff, 0xfe, 0x00]);
  const badUtf8Hash = createHash("sha256").update(badUtf8).digest("hex");
  const badUtf8RelPath = `assets/grammars/licenses/${badUtf8Hash}.txt`;
  await writeFile(path.join(licenseFixture, badUtf8RelPath), badUtf8);
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(
      {
        ...validSources,
        languages: [
          { ...validSources.languages[0], license_file: badUtf8RelPath },
          validSources.languages[1],
        ],
      },
      null,
      2,
    ),
  );
  const badUtf8Result = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(badUtf8Result.status, 0, "Invalid UTF-8 license file must fail verification");
  await rm(path.join(licenseFixture, badUtf8RelPath));
  await writeFile(
    path.join(licenseFixture, "assets/grammars/sources.json"),
    JSON.stringify(validSources, null, 2),
  );

  // Corrupted license bytes must fail --check.
  await writeFile(path.join(licenseFixture, licenseRelPath), "Tampered License\n");
  const tampered = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(tampered.status, 0, "Tampered license file must fail verification");
  assert.match(tampered.stderr, /License notice drift/);

  // Missing license file must fail --check.
  await rm(path.join(licenseFixture, licenseRelPath));
  const missing = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0, "Missing license file must fail verification");

  // Extra unreferenced license file is tolerated in write mode but must fail --check.
  await writeFile(path.join(licenseFixture, licenseRelPath), licenseText);
  await writeFile(
    path.join(licenseFixture, "assets/grammars/licenses/stray.txt"),
    "Unreferenced\n",
  );
  run(process.execPath, [noticesScript], licenseFixture);
  const unreferenced = spawnSync(process.execPath, [noticesScript, "--check"], {
    cwd: licenseFixture,
    encoding: "utf8",
  });
  assert.notEqual(unreferenced.status, 0, "Unreferenced license file must fail verification");
  assert.match(unreferenced.stderr, /Unreferenced license notice file/);

  // Verify publish-assets.mjs --check confines reads to canonical regular files
  // and rejects both path-traversal grammar_file values and symlinked assets.
  const publishFixture = path.join(temporary, "publish-fixture");
  for (const dir of [
    "assets/grammars",
    "assets/grammar-raw/example",
    "assets/standard/languages",
    "assets/upstream/curated/grammars",
    "assets/upstream/curated/themes",
    "node/ferriki/scripts",
    "scripts",
  ])
    await mkdir(path.join(publishFixture, dir), { recursive: true });
  for (const [src, dst] of [
    ["./publish-assets.mjs", "scripts/publish-assets.mjs"],
    ["./asset-store.mjs", "scripts/asset-store.mjs"],
    ["./cleanup-bootstrap-assets.mjs", "scripts/cleanup-bootstrap-assets.mjs"],
    ["./bunny-storage.mjs", "scripts/bunny-storage.mjs"],
    ["../node/ferriki/scripts/asset-path.mjs", "node/ferriki/scripts/asset-path.mjs"],
  ])
    await copyFile(new URL(src, import.meta.url), path.join(publishFixture, dst));
  const grammarBytes = '{"scopeName":"source.example"}\n';
  const grammarHash = createHash("sha256").update(grammarBytes).digest("hex");
  const payloadBytes = "payload";
  const payloadHash = createHash("sha256").update(payloadBytes).digest("hex");
  const bcBytes = "bytecode";
  const bcHash = createHash("sha256").update(bcBytes).digest("hex");
  const themePayloadBytes = "theme-payload";
  const themePayloadHash = createHash("sha256").update(themePayloadBytes).digest("hex");
  const themeSourceBytes = '{"name":"dark"}\n';
  const themeSourceHash = createHash("sha256").update(themeSourceBytes).digest("hex");
  const publishCatalog = {
    languages: {
      entries: [
        {
          id: "example",
          scope_name: "source.example",
          asset_file: "example.fkgram",
          display_name: "Example",
          aliases: ["ex"],
          embedded_langs: [],
          embedded_langs_lazy: [],
          inject_to: [],
        },
      ],
    },
    themes: {
      entries: [{ id: "dark", asset_file: "dark.fktheme" }],
    },
    release: {
      storageLayout: "language-hash-v2",
      assets: {
        "languages/example.fkgram": { sha256: payloadHash, size: payloadBytes.length },
        "languages/example.fkbc": { sha256: bcHash, size: bcBytes.length },
        "themes/dark.fktheme": { sha256: themePayloadHash, size: themePayloadBytes.length },
      },
    },
    theme_sources: [{ id: "dark", theme_file: "dark.json", sha256: themeSourceHash }],
  };
  const publishSources = {
    version: 2,
    languages: [
      {
        id: "example",
        grammar_file: "example.json",
        scope_name: "source.example",
        display_name: "Example",
        aliases: ["ex"],
        embedded_langs: [],
        embedded_langs_lazy: [],
        inject_to: [],
        sha256: grammarHash,
        upstream_sha256: grammarHash,
      },
    ],
  };
  await mkdir(path.join(publishFixture, "assets/standard/themes"), { recursive: true });
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(publishCatalog, null, 2),
  );
  await writeFile(
    path.join(publishFixture, "assets/grammars/sources.json"),
    JSON.stringify(publishSources, null, 2),
  );
  await writeFile(
    path.join(publishFixture, "assets/standard/languages/example.fkgram"),
    payloadBytes,
  );
  await writeFile(
    path.join(publishFixture, "assets/standard/languages/example.fkbc"),
    bcBytes,
  );
  await writeFile(
    path.join(publishFixture, "assets/standard/themes/dark.fktheme"),
    themePayloadBytes,
  );
  await writeFile(
    path.join(publishFixture, "assets/upstream/curated/themes/dark.json"),
    themeSourceBytes,
  );
  await writeFile(
    path.join(publishFixture, "assets/upstream/curated/grammars/example.json"),
    grammarBytes,
  );
  await writeFile(
    path.join(publishFixture, `assets/grammar-raw/example/${grammarHash}`),
    grammarBytes,
  );
  const publishScript = path.join(publishFixture, "scripts/publish-assets.mjs");
  const baseAssetCatalogFile = path.join(temporary, "base-asset-catalog.json");
  await writeFile(baseAssetCatalogFile, JSON.stringify(publishCatalog, null, 2));
  run(
    process.execPath,
    [publishScript, "--check", "--base-asset-catalog", baseAssetCatalogFile],
    publishFixture,
  );

  // Updated compiled .fktheme bytes/hash/formatVersion (e.g. after a trusted encoder
  // format bump) must be allowed when theme selection and theme_sources stay pinned.
  const reencodedThemePayloadBytes = "theme-payload-v4";
  const reencodedThemePayloadHash = createHash("sha256")
    .update(reencodedThemePayloadBytes)
    .digest("hex");
  await writeFile(
    path.join(publishFixture, "assets/standard/themes/dark.fktheme"),
    reencodedThemePayloadBytes,
  );
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(
      {
        ...publishCatalog,
        release: {
          ...publishCatalog.release,
          assets: {
            ...publishCatalog.release.assets,
            "themes/dark.fktheme": {
              sha256: reencodedThemePayloadHash,
              size: reencodedThemePayloadBytes.length,
              formatVersion: 4,
            },
          },
        },
      },
      null,
      2,
    ),
  );
  run(
    process.execPath,
    [publishScript, "--check", "--base-asset-catalog", baseAssetCatalogFile],
    publishFixture,
  );
  await writeFile(
    path.join(publishFixture, "assets/standard/themes/dark.fktheme"),
    themePayloadBytes,
  );
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(publishCatalog, null, 2),
  );

  // Altered theme section vs. BASE_SHA must fail --base-asset-catalog.
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(
      {
        ...publishCatalog,
        themes: { entries: [] },
        theme_sources: [],
        release: {
          ...publishCatalog.release,
          assets: {
            "languages/example.fkgram": publishCatalog.release.assets["languages/example.fkgram"],
            "languages/example.fkbc": publishCatalog.release.assets["languages/example.fkbc"],
          },
        },
      },
      null,
      2,
    ),
  );
  const themeDrift = spawnSync(
    process.execPath,
    [publishScript, "--check", "--base-asset-catalog", baseAssetCatalogFile],
    { cwd: publishFixture, encoding: "utf8" },
  );
  assert.notEqual(
    themeDrift.status,
    0,
    "Altered theme section in assets/catalog.json must fail --base-asset-catalog",
  );
  assert.match(themeDrift.stderr, /Theme catalog drift against BASE_SHA/);

  // Omitting or changing release.storageLayout vs. BASE_SHA must fail --base-asset-catalog.
  const releaseWithoutLayout = { ...publishCatalog.release };
  delete releaseWithoutLayout.storageLayout;
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify({ ...publishCatalog, release: releaseWithoutLayout }, null, 2),
  );
  const omittedStorageLayout = spawnSync(
    process.execPath,
    [publishScript, "--check", "--base-asset-catalog", baseAssetCatalogFile],
    { cwd: publishFixture, encoding: "utf8" },
  );
  assert.notEqual(
    omittedStorageLayout.status,
    0,
    "Omitting release.storageLayout must fail --base-asset-catalog",
  );
  assert.match(omittedStorageLayout.stderr, /Release storage layout drift against BASE_SHA/);

  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(
      {
        ...publishCatalog,
        release: { ...publishCatalog.release, storageLayout: "language-hash-v1" },
      },
      null,
      2,
    ),
  );
  const changedStorageLayout = spawnSync(
    process.execPath,
    [publishScript, "--check", "--base-asset-catalog", baseAssetCatalogFile],
    { cwd: publishFixture, encoding: "utf8" },
  );
  assert.notEqual(
    changedStorageLayout.status,
    0,
    "Changing release.storageLayout must fail --base-asset-catalog",
  );
  assert.match(changedStorageLayout.stderr, /Release storage layout drift against BASE_SHA/);

  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(publishCatalog, null, 2),
  );

  // Duplicate language ID in sources.json must fail --check.
  await writeFile(
    path.join(publishFixture, "assets/grammars/sources.json"),
    JSON.stringify(
      {
        ...publishSources,
        languages: [publishSources.languages[0], { ...publishSources.languages[0] }],
      },
      null,
      2,
    ),
  );
  const dupSourceLanguage = spawnSync(process.execPath, [publishScript, "--check"], {
    cwd: publishFixture,
    encoding: "utf8",
  });
  assert.notEqual(
    dupSourceLanguage.status,
    0,
    "Duplicate language ID in sources.json must fail publish --check",
  );
  assert.match(dupSourceLanguage.stderr, /Duplicate language ID in assets\/grammars\/sources\.json/);
  await writeFile(
    path.join(publishFixture, "assets/grammars/sources.json"),
    JSON.stringify(publishSources, null, 2),
  );

  // Non-canonical / swapped asset_file name in catalog.json must fail --check.
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(
      {
        ...publishCatalog,
        languages: {
          entries: [{ ...publishCatalog.languages.entries[0], asset_file: "other.fkgram" }],
        },
      },
      null,
      2,
    ),
  );
  const swappedAssetFile = spawnSync(process.execPath, [publishScript, "--check"], {
    cwd: publishFixture,
    encoding: "utf8",
  });
  assert.notEqual(
    swappedAssetFile.status,
    0,
    "Non-canonical asset_file name in catalog.json must fail publish --check",
  );
  assert.match(swappedAssetFile.stderr, /Invalid language asset_file/);

  // Dropped alias in catalog.json (runtime metadata drift vs. sources.json) must fail --check.
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(
      {
        ...publishCatalog,
        languages: {
          entries: [{ ...publishCatalog.languages.entries[0], aliases: [] }],
        },
      },
      null,
      2,
    ),
  );
  const droppedAlias = spawnSync(process.execPath, [publishScript, "--check"], {
    cwd: publishFixture,
    encoding: "utf8",
  });
  assert.notEqual(
    droppedAlias.status,
    0,
    "Dropped alias in catalog.json must fail publish --check",
  );
  assert.match(droppedAlias.stderr, /Language runtime metadata drift: example\.aliases/);

  // Missing theme_sources row must fail --check.
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify({ ...publishCatalog, theme_sources: [] }, null, 2),
  );
  const missingThemeSource = spawnSync(process.execPath, [publishScript, "--check"], {
    cwd: publishFixture,
    encoding: "utf8",
  });
  assert.notEqual(
    missingThemeSource.status,
    0,
    "Missing theme_sources row must fail publish --check",
  );
  assert.match(missingThemeSource.stderr, /Theme catalog drift/);
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(publishCatalog, null, 2),
  );

  // Missing language payload in release.assets must fail --check.
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(
      {
        ...publishCatalog,
        release: {
          ...publishCatalog.release,
          assets: { "languages/example.fkbc": publishCatalog.release.assets["languages/example.fkbc"] },
        },
      },
      null,
      2,
    ),
  );
  const missingPayload = spawnSync(process.execPath, [publishScript, "--check"], {
    cwd: publishFixture,
    encoding: "utf8",
  });
  assert.notEqual(
    missingPayload.status,
    0,
    "Missing language payload in release.assets must fail publish --check",
  );
  assert.match(missingPayload.stderr, /Missing release payload/);

  // Extra unreferenced payload key in release.assets must fail --check.
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(
      {
        ...publishCatalog,
        release: {
          ...publishCatalog.release,
          assets: {
            ...publishCatalog.release.assets,
            "languages/orphan.fkgram": { sha256: payloadHash, size: payloadBytes.length },
          },
        },
      },
      null,
      2,
    ),
  );
  const extraPayload = spawnSync(process.execPath, [publishScript, "--check"], {
    cwd: publishFixture,
    encoding: "utf8",
  });
  assert.notEqual(
    extraPayload.status,
    0,
    "Unreferenced release payload in release.assets must fail publish --check",
  );
  assert.match(extraPayload.stderr, /Unreferenced release payload/);
  await writeFile(
    path.join(publishFixture, "assets/catalog.json"),
    JSON.stringify(publishCatalog, null, 2),
  );

  // Path-traversal grammar_file must fail --check.
  await writeFile(
    path.join(publishFixture, "assets/grammars/sources.json"),
    JSON.stringify(
      {
        ...publishSources,
        languages: [{ ...publishSources.languages[0], grammar_file: "../../catalog.json" }],
      },
      null,
      2,
    ),
  );
  const traversal = spawnSync(process.execPath, [publishScript, "--check"], {
    cwd: publishFixture,
    encoding: "utf8",
  });
  assert.notEqual(traversal.status, 0, "Path-traversal grammar_file must fail publish --check");
  assert.match(traversal.stderr, /Invalid grammar file/);

  // Symlinked grammar_file must fail --check.
  await writeFile(
    path.join(publishFixture, "assets/grammars/sources.json"),
    JSON.stringify(publishSources, null, 2),
  );
  const externalTarget = path.join(temporary, "outside.json");
  await writeFile(externalTarget, grammarBytes);
  await rm(path.join(publishFixture, "assets/upstream/curated/grammars/example.json"));
  await symlink(
    externalTarget,
    path.join(publishFixture, "assets/upstream/curated/grammars/example.json"),
  );
  const symlinked = spawnSync(process.execPath, [publishScript, "--check"], {
    cwd: publishFixture,
    encoding: "utf8",
  });
  assert.notEqual(symlinked.status, 0, "Symlinked grammar_file must fail publish --check");
  assert.match(symlinked.stderr, /Symlinked asset path/);

  // Symlinked intermediate directory (assets/upstream/curated/grammars) must also fail --check.
  const externalGrammarsDir = path.join(temporary, "external-grammars");
  await mkdir(externalGrammarsDir);
  await writeFile(path.join(externalGrammarsDir, "example.json"), grammarBytes);
  await rm(path.join(publishFixture, "assets/upstream/curated/grammars"), { recursive: true });
  await symlink(
    externalGrammarsDir,
    path.join(publishFixture, "assets/upstream/curated/grammars"),
  );
  const symlinkedDir = spawnSync(process.execPath, [publishScript, "--check"], {
    cwd: publishFixture,
    encoding: "utf8",
  });
  assert.notEqual(
    symlinkedDir.status,
    0,
    "Symlinked assets/upstream/curated/grammars directory must fail publish --check",
  );
  assert.match(symlinkedDir.stderr, /Symlinked asset path/);

  // Verify scripts/verify-grammar-bundle.mjs compares rebuilt vs. prepare bundles byte-for-byte.
  const verifyBundleScript = fileURLToPath(new URL("./verify-grammar-bundle.mjs", import.meta.url));
  const rebuiltBundleDir = path.join(temporary, "rebuilt-bundle");
  const prepareBundleDir = path.join(temporary, "prepare-bundle");
  const sampleBundleFiles = {
    "assets/grammars/sources.json": '{"version":2}\n',
    "assets/grammars/catalog.json": '{"version":1,"languages":[]}\n',
    "assets/catalog.json": '{"release":{"storageLayout":"language-hash-v2"}}\n',
    "assets/standard/GRAMMAR-NOTICES.md": "# Notices\n",
    "assets/standard/languages/example.fkgram": "fkgram-bytes",
    "assets/standard/languages/example.fkbc": "fkbc-bytes",
    "report.json": '{"version":1}\n',
  };
  for (const dir of [rebuiltBundleDir, prepareBundleDir]) {
    for (const [relPath, content] of Object.entries(sampleBundleFiles)) {
      const target = path.join(dir, relPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  run(process.execPath, [verifyBundleScript, rebuiltBundleDir, prepareBundleDir], temporary);

  // Prove prepare (after materialize-assets) and verify (after generate-ferriki-catalog)
  // diverge on catalog.mjs before --metadata-only and match byte-for-byte after writeMetadata().
  const { writeMetadata } = await import(new URL("./asset-store.mjs", import.meta.url).href);
  const metadataLock = {
    version: 1,
    languages: {
      format_version: 3,
      source: { upstream: "ferriki-curated", version: null, commit: null },
      entries: publishCatalog.languages.entries,
    },
    themes: {
      format_version: 3,
      source: { upstream: "ferriki-curated", version: null, commit: null },
      entries: [
        { id: "dark", asset_file: "dark.fktheme", display_name: "Dark", theme_type: "dark" },
      ],
    },
    release: publishCatalog.release,
  };
  await writeMetadata(prepareBundleDir, metadataLock);
  await writeMetadata(rebuiltBundleDir, metadataLock);
  // Simulate generate-ferriki-catalog.mjs header in verify before --metadata-only:
  const genCatalogScript = fileURLToPath(
    new URL("./generate-ferriki-catalog.mjs", import.meta.url),
  );
  run(
    process.execPath,
    [genCatalogScript, path.join(rebuiltBundleDir, "assets/standard")],
    temporary,
  );
  const beforeMetadataSync = spawnSync(
    process.execPath,
    [verifyBundleScript, rebuiltBundleDir, prepareBundleDir],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.notEqual(
    beforeMetadataSync.status,
    0,
    "Unnormalized generate-ferriki-catalog.mjs vs writeMetadata catalog.mjs must diverge",
  );
  assert.match(beforeMetadataSync.stderr, /assets\/standard\/catalog\.mjs/);
  // After both paths run materialize-assets.mjs --metadata-only (writeMetadata), bundles match byte-for-byte.
  await writeMetadata(rebuiltBundleDir, metadataLock);
  run(process.execPath, [verifyBundleScript, rebuiltBundleDir, prepareBundleDir], temporary);

  // Tampered compiled payload in prepare bundle must fail verification.
  await writeFile(
    path.join(prepareBundleDir, "assets/standard/languages/example.fkbc"),
    "tampered-fkbc-bytes",
  );
  const tamperedBundle = spawnSync(
    process.execPath,
    [verifyBundleScript, rebuiltBundleDir, prepareBundleDir],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.notEqual(tamperedBundle.status, 0, "Tampered .fkbc in prepare bundle must fail verify");
  assert.match(tamperedBundle.stderr, /Publish bundle digest mismatch/);
  await writeFile(
    path.join(prepareBundleDir, "assets/standard/languages/example.fkbc"),
    "fkbc-bytes",
  );

  // Extra unexpected file in prepare bundle must fail verification.
  await writeFile(path.join(prepareBundleDir, "assets/standard/extra.txt"), "extra");
  const extraBundleFile = spawnSync(
    process.execPath,
    [verifyBundleScript, rebuiltBundleDir, prepareBundleDir],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.notEqual(extraBundleFile.status, 0, "Extra file in prepare bundle must fail verify");
  assert.match(extraBundleFile.stderr, /Unexpected file in prepare publish bundle/);
  await rm(path.join(prepareBundleDir, "assets/standard/extra.txt"));

  // Symlinked file in prepare bundle must fail verification.
  const bundleSymlinkTarget = path.join(temporary, "bundle-symlink-target");
  await writeFile(bundleSymlinkTarget, "fkbc-bytes");
  await rm(path.join(prepareBundleDir, "assets/standard/languages/example.fkbc"));
  await symlink(
    bundleSymlinkTarget,
    path.join(prepareBundleDir, "assets/standard/languages/example.fkbc"),
  );
  const symlinkBundle = spawnSync(
    process.execPath,
    [verifyBundleScript, rebuiltBundleDir, prepareBundleDir],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.notEqual(symlinkBundle.status, 0, "Symlink in prepare bundle must fail verify");
  assert.match(symlinkBundle.stderr, /must not contain symlinks/);

  // Verify scripts/write-grammar-update-report.mjs --check-locks validates report.json
  // against base and candidate sources.json / catalog.json locks.
  const reportScript = fileURLToPath(
    new URL("./write-grammar-update-report.mjs", import.meta.url),
  );
  const reportFixtureDir = path.join(temporary, "report-locks-fixture");
  await mkdir(reportFixtureDir);
  const baseLockSources = {
    version: 2,
    repositories: {
      vscode: { repository: "microsoft/vscode", ref: "main", commit: "1".repeat(40) },
    },
    languages: [
      {
        id: "example",
        repository_id: "vscode",
        upstream_repository: "microsoft/vscode",
        upstream_path: "extensions/example/syntaxes/example.tmLanguage.json",
        license: "MIT",
        license_file: `assets/grammars/licenses/${"1".repeat(64)}.txt`,
        upstream_sha256: "2".repeat(64),
        sha256: "3".repeat(64),
      },
    ],
  };
  const candidateLockSources = {
    version: 2,
    repositories: {
      vscode: { repository: "microsoft/vscode", ref: "main", commit: "4".repeat(40) },
    },
    languages: [
      {
        id: "example",
        repository_id: "vscode",
        upstream_repository: "microsoft/vscode",
        upstream_path: "extensions/example/syntaxes/example.tmLanguage.json",
        license: "MIT",
        license_file: `assets/grammars/licenses/${"5".repeat(64)}.txt`,
        upstream_sha256: "6".repeat(64),
        sha256: "7".repeat(64),
      },
    ],
  };
  const lockCatalog = {
    version: 1,
    languages: [{ id: "example", repository_id: "vscode", selector: { path: "example.json" } }],
  };
  const validReportJson = {
    version: 1,
    changed: true,
    configuration_changed: false,
    repositories: candidateLockSources.repositories,
    changes: [
      {
        id: "example",
        added: false,
        before: "2".repeat(64),
        after: "6".repeat(64),
        repository_id: "vscode",
        license_changed: true,
      },
    ],
    retired_patches: [],
    external_scopes: [],
    grammar_count: 1,
  };
  const reportBaseSourcesFile = path.join(reportFixtureDir, "base-sources.json");
  const reportBaseCatalogFile = path.join(reportFixtureDir, "base-catalog.json");
  const reportCandSourcesFile = path.join(reportFixtureDir, "cand-sources.json");
  const reportCandCatalogFile = path.join(reportFixtureDir, "cand-catalog.json");
  const reportJsonFile = path.join(reportFixtureDir, "report.json");
  await writeFile(reportBaseSourcesFile, JSON.stringify(baseLockSources, null, 2));
  await writeFile(reportBaseCatalogFile, JSON.stringify(lockCatalog, null, 2));
  await writeFile(reportCandSourcesFile, JSON.stringify(candidateLockSources, null, 2));
  await writeFile(reportCandCatalogFile, JSON.stringify(lockCatalog, null, 2));
  await writeFile(reportJsonFile, JSON.stringify(validReportJson, null, 2));

  const checkLocksArgs = [
    reportScript,
    "--check-locks",
    "--base-sources",
    reportBaseSourcesFile,
    "--base-catalog",
    reportBaseCatalogFile,
    "--sources",
    reportCandSourcesFile,
    "--catalog",
    reportCandCatalogFile,
    reportJsonFile,
  ];
  run(process.execPath, checkLocksArgs, reportFixtureDir);

  // Tampered report claiming no changes when a grammar & license changed must fail.
  await writeFile(
    reportJsonFile,
    JSON.stringify({ ...validReportJson, changed: false, changes: [] }, null, 2),
  );
  const tamperedEmptyChanges = spawnSync(process.execPath, checkLocksArgs, {
    cwd: reportFixtureDir,
    encoding: "utf8",
  });
  assert.notEqual(
    tamperedEmptyChanges.status,
    0,
    "Report claiming no changes when a grammar changed must fail --check-locks",
  );
  assert.match(tamperedEmptyChanges.stderr, /Report changes drift/);

  // Tampered report hiding a license change must fail.
  await writeFile(
    reportJsonFile,
    JSON.stringify(
      {
        ...validReportJson,
        changes: [{ ...validReportJson.changes[0], license_changed: false }],
      },
      null,
      2,
    ),
  );
  const tamperedLicenseFlag = spawnSync(process.execPath, checkLocksArgs, {
    cwd: reportFixtureDir,
    encoding: "utf8",
  });
  assert.notEqual(
    tamperedLicenseFlag.status,
    0,
    "Report hiding license_changed must fail --check-locks",
  );
  assert.match(tamperedLicenseFlag.stderr, /Report changes drift/);

  // Tampered report with wrong repository commit must fail.
  await writeFile(
    reportJsonFile,
    JSON.stringify(
      {
        ...validReportJson,
        repositories: baseLockSources.repositories,
      },
      null,
      2,
    ),
  );
  const tamperedRepoPin = spawnSync(process.execPath, checkLocksArgs, {
    cwd: reportFixtureDir,
    encoding: "utf8",
  });
  assert.notEqual(
    tamperedRepoPin.status,
    0,
    "Report with stale repository commit must fail --check-locks",
  );
  assert.match(tamperedRepoPin.stderr, /Report repository pins drift/);

  // Bytecode-refresh-only report (no source changes) must pass when locks match.
  await writeFile(
    reportJsonFile,
    JSON.stringify(
      {
        ...validReportJson,
        changed: false,
        repositories: baseLockSources.repositories,
        changes: [],
      },
      null,
      2,
    ),
  );
  run(
    process.execPath,
    [
      reportScript,
      "--check-locks",
      "--base-sources",
      reportBaseSourcesFile,
      "--base-catalog",
      reportBaseCatalogFile,
      "--sources",
      reportBaseSourcesFile,
      "--catalog",
      reportBaseCatalogFile,
      reportJsonFile,
    ],
    reportFixtureDir,
  );

  console.log(
    "Grammar update workflow verified: draft creation, PR refresh, identical replay, concurrent push rejection, and manual-commit preservation.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
