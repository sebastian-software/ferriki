import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const { load } = createRequire(new URL("../node/package.json", import.meta.url))("js-yaml");
const workflow = load(
  await readFile(new URL("../.github/workflows/grammar-updates.yml", import.meta.url), "utf8"),
);
const job = workflow.jobs.update;
const publication = job.steps.find((step) => step.name === "Open a reviewable update");
assert.equal(workflow.on.schedule[0].cron, "0 6 * * 1");
assert(Object.hasOwn(workflow.on, "workflow_dispatch"));
assert.equal(job.env.UPDATE_BRANCH, "codex/grammar-updates");
assert.equal(job.steps[0].with.ref, "${{ github.event.repository.default_branch }}");
assert.equal(publication.if, "steps.prepare.outputs.changed == 'true'");
const requiredSteps = [
  "Validate and apply the candidate",
  "Verify native compatibility",
  "Verify grammar output agreement",
];
for (const name of requiredSteps) {
  const index = job.steps.findIndex((step) => step.name === name);
  assert(index >= 0 && index < job.steps.indexOf(publication), name);
  assert.equal(job.steps[index].if, publication.if, name);
}

// Exercise the actual publication shell with real local Git repositories.
// GitHub is mocked; every origin points at the disposable local bare repository.
const temporary = await mkdtemp(path.join(tmpdir(), "ferriki-grammar-workflow-"));
const origin = path.join(temporary, "origin.git");
const mockBin = path.join(temporary, "bin");
const branch = job.env.UPDATE_BRANCH;
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
async function runner(generation, existing = true, raceDirectory) {
  const directory = path.join(temporary, `runner-${++iteration}`);
  git(["clone", "--quiet", origin, directory]);
  await writeFile(path.join(directory, "assets/grammars/sources.json"), `${generation}\n`);
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
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", publication.run], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...baseEnv,
      PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
      CANDIDATE: candidate,
      DEFAULT_BRANCH: "main",
      UPDATE_BRANCH: branch,
      GRAMMAR_TEST_GH_LOG: log,
      GRAMMAR_TEST_EXISTING_PR: existing ? "https://github.invalid/pull/1" : "",
      GRAMMAR_TEST_REAL_GIT: realGit,
      GRAMMAR_TEST_RACE_DIRECTORY: raceDirectory ?? "",
      GIT_AUTHOR_DATE: `2026-10-12T06:0${iteration}:00Z`,
      GIT_COMMITTER_DATE: `2026-10-12T06:0${iteration}:00Z`,
    },
  });
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { ...result, calls };
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
    "assets/upstream/textmate-grammars-themes",
    "assets/shiki",
    "scripts",
  ])
    await mkdir(path.join(seed, directory), { recursive: true });
  for (const file of [
    "assets/grammars/sources.json",
    "assets/upstream/textmate-grammars-themes/example.json",
    "assets/shiki/example.fkgram",
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

  const first = await runner(1, false);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(
    first.calls.map((call) => call[1]),
    ["list", "create"],
  );
  assert(first.calls[1].includes("--draft"));
  assert.equal(git(["show", `${branch}:assets/grammars/sources.json`], origin), "1");
  assert(!git(["ls-tree", "-r", "--name-only", branch], origin).includes("unrelated.txt"));
  const firstTip = remoteTip();

  const identical = await runner(1);
  assert.equal(identical.status, 0, identical.stderr);
  assert.equal(remoteTip(), firstTip, "An identical tree must not be pushed again");
  assert.deepEqual(
    identical.calls.map((call) => call[1]),
    ["list", "edit"],
  );

  const newer = await runner(2);
  assert.equal(newer.status, 0, newer.stderr);
  assert.notEqual(remoteTip(), firstTip);
  assert.equal(git(["show", `${branch}:assets/grammars/sources.json`], origin), "2");
  assert.deepEqual(
    newer.calls.map((call) => call[1]),
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
  const concurrent = await runner(3, true, race);
  assert.notEqual(concurrent.status, 0, "A concurrent update must reject the push lease");
  assert.equal(remoteTip(), manualTip);
  assert.deepEqual(
    concurrent.calls.map((call) => call[1]),
    ["list"],
  );

  const manual = await runner(4);
  assert.notEqual(manual.status, 0, "A manual commit must stop automatic replacement");
  assert.match(manual.stderr, /manual commit/);
  assert.equal(remoteTip(), manualTip);
  assert.deepEqual(
    manual.calls.map((call) => call[1]),
    ["list"],
  );
  assert.equal(git(["log", "-1", "--format=%ae", firstTip], origin), botEmail);
  console.log(
    "Grammar update workflow verified: draft creation, PR refresh, identical replay, concurrent push rejection, and manual-commit preservation.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
