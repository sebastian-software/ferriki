// Preserve focused JavaScript CPU profiles and macOS native samples for #222.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveFerrikiPlatformTarget } from "../ferriki/platforms.mjs";
import { loadCorpus, repoRoot, sha256 } from "./tiobe-benchmark.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const nodeRoot = dirname(dirname(scriptPath));
const resultRoot = join(nodeRoot, "benchmarks/curated/results/prism-investigation");
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "8" },
    "sample-seconds": { type: "string", default: "6" },
    output: {
      type: "string",
      default: "node/benchmarks/curated/results/prism-investigation/profiles/current",
    },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log(
    "Usage: node scripts/capture-prism-profiles.mjs [--seconds 8] [--sample-seconds 6] [--output node/benchmarks/curated/results/prism-investigation/profiles/current]",
  );
  process.exit(0);
}

assert.equal(process.platform, "darwin", "Native sample capture currently supports macOS only");
const seconds = Number(values.seconds);
const sampleSeconds = Number(values["sample-seconds"]);
assert.ok(Number.isSafeInteger(seconds) && seconds >= 3 && seconds <= 60, "Invalid --seconds");
assert.ok(
  Number.isSafeInteger(sampleSeconds) && sampleSeconds >= 2 && sampleSeconds < seconds,
  "Invalid --sample-seconds",
);

const outputRoot = resolve(repoRoot, values.output);
await mkdir(dirname(outputRoot), { recursive: true });
await mkdir(outputRoot, { recursive: false });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const timingRoot = join(resultRoot, "timings");
const ordinary = await readJson(join(timingRoot, "ordinary-build-receipt.json"));
const modeReport = await readJson(join(timingRoot, "output-modes.json"));
const matrix = await readJson(join(timingRoot, "curated-run-01.json"));
const measuredModeHarnessPath = join(
  timingRoot,
  "harness/bench-prism-output-modes.measured.mjs",
);
const prismVersion = (await readJson(join(nodeRoot, "node_modules/prismjs/package.json"))).version;
const profileReceiptPath = join(nodeRoot, "ferriki/.benchmark-build.json");
const profileReceiptBytes = await readFile(profileReceiptPath);
const profileReceipt = JSON.parse(profileReceiptBytes);
assert.equal(profileReceipt.cargoProfileEnv.CARGO_PROFILE_RELEASE_DEBUG, "line-tables-only");
assert.equal(profileReceipt.cargoProfileEnv.CARGO_PROFILE_RELEASE_STRIP, "none");
assert.equal(profileReceipt.rustSourceSha256, ordinary.receipt.rustSourceSha256);
assert.equal(modeReport.identity.addon.sha256, ordinary.ordinaryBinarySha256);
assert.equal(matrix.nativeBuild.binarySha256, ordinary.ordinaryBinarySha256);
const measuredModeHarnessSha256 = sha256(await readFile(measuredModeHarnessPath));
assert.equal(
  modeReport.identity.harnessSha256,
  measuredModeHarnessSha256,
  "Output-mode report does not match its archived measured harness",
);
assert.equal(
  modeReport.harnessSha256,
  measuredModeHarnessSha256,
  "Output-mode report top-level harness hash differs from its identity receipt",
);
assert.equal(
  modeReport.identity.sharedHarnessSha256,
  sha256(await readFile(join(nodeRoot, "scripts/tiobe-benchmark.mjs"))),
);
assert.equal(
  matrix.harnessSha256,
  sha256(
    Buffer.concat([
      await readFile(join(nodeRoot, "scripts/bench-tiobe.mjs")),
      await readFile(join(nodeRoot, "scripts/tiobe-benchmark.mjs")),
    ]),
  ),
);
assert.equal(
  modeReport.identity.assetsSha256,
  sha256(await readFile(join(nodeRoot, "ferriki/assets/shiki/release-manifest.json"))),
);

const target = resolveFerrikiPlatformTarget();
assert.ok(target, "No supported native platform");
const require = createRequire(new URL("../ferriki/native.mjs", import.meta.url));
const addonCandidates = [
  `${target.packageName}/ferriki.node`,
  join(nodeRoot, "ferriki/dist", target.binaryName),
  join(nodeRoot, "ferriki/dist/ferriki.node"),
  join(nodeRoot, "ferriki/ferriki.node"),
];
let loadedAddon;
for (const candidate of addonCandidates) {
  try {
    loadedAddon = require.resolve(candidate);
    require(loadedAddon);
    break;
  } catch {
    // Follow the same candidate order as the package facade.
  }
}
assert.ok(loadedAddon, "No native addon loaded");
assert.equal(digest(await readFile(loadedAddon)), profileReceipt.binarySha256);
assert.notEqual(
  profileReceipt.binarySha256,
  ordinary.ordinaryBinarySha256,
  "Symbol-bearing build unexpectedly matches ordinary timing binary",
);

const corpus = loadCorpus("curated");
const selected = new Set(["cpp", "typescript", "tsx", "json", "html", "astro"]);
const languages = corpus.languages.filter((language) => selected.has(language.textmate));
assert.equal(languages.length, selected.size);
const jobs = [];
for (const language of languages) {
  if (language.prism) jobs.push({ kind: "js", engine: "prism", language: language.textmate });
  jobs.push({ kind: "js", engine: "ferriki", language: language.textmate });
  jobs.push({ kind: "native", engine: "ferriki", language: language.textmate });
}

const guardedInputPaths = [
  profileReceiptPath,
  loadedAddon,
  join(nodeRoot, "ferriki/assets/shiki/release-manifest.json"),
  join(nodeRoot, "benchmarks/curated/manifest.json"),
  join(nodeRoot, "pnpm-lock.yaml"),
  join(nodeRoot, "package.json"),
  join(nodeRoot, "node_modules/prismjs/package.json"),
  join(nodeRoot, "node_modules/shiki/package.json"),
  join(nodeRoot, "scripts/capture-prism-profiles.mjs"),
  join(nodeRoot, "scripts/profile-tiobe.mjs"),
  join(nodeRoot, "scripts/bench-tiobe.mjs"),
  join(nodeRoot, "scripts/tiobe-benchmark.mjs"),
  join(nodeRoot, "scripts/bench-prism-output-modes.mjs"),
  measuredModeHarnessPath,
  join(timingRoot, "ordinary-build-receipt.json"),
  join(timingRoot, "curated-run-01.json"),
  join(timingRoot, "curated-run-02.json"),
  join(timingRoot, "output-modes.json"),
];
for (const language of languages) {
  guardedInputPaths.push(join(nodeRoot, "benchmarks/curated/fixtures", language.file));
}
const guardedInputs = [...new Set(guardedInputPaths)].sort();
async function identitySnapshot() {
  const files = [];
  for (const path of guardedInputs) {
    files.push({
      path: path.slice(repoRoot.length + 1),
      sha256: sha256(await readFile(path)),
    });
  }
  return files;
}
const initialIdentity = await identitySnapshot();

function spawnCapture(command, args, env) {
  const child = spawn(command, args, {
    cwd: nodeRoot,
    env: { ...process.env, FERRIKI_ASSETS_REMOTE: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function sampleProcess(pid, filePath) {
  const sampler = spawn(
    "/usr/bin/sample",
    [String(pid), String(sampleSeconds), "1", "-file", filePath],
    {
      cwd: nodeRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  sampler.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  sampler.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return new Promise((resolvePromise, rejectPromise) => {
    sampler.on("error", rejectPromise);
    sampler.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

async function runJob(job) {
  const id = `${job.kind}-${job.engine}-${job.language}`;
  const identityBefore = await identitySnapshot();
  assert.deepEqual(
    identityBefore,
    initialIdentity,
    `${id}: profile inputs changed since capture start`,
  );
  const jobRoot = join(outputRoot, id);
  await mkdir(jobRoot, { recursive: true });
  const commandArgs = [
    "scripts/profile-tiobe.mjs",
    "--corpus",
    "curated",
    "--language",
    job.language,
    "--size",
    "large",
    "--engine",
    job.engine,
    "--boundary",
    job.kind === "native" ? "native" : "facade",
    "--seconds",
    String(seconds),
  ];
  const cpuProfilePath = job.kind === "js" ? join(jobRoot, "cpu-profile.json") : null;
  const running = spawnCapture(
    process.execPath,
    commandArgs,
    cpuProfilePath ? { FERRIKI_CPU_PROFILE_PATH: cpuProfilePath } : {},
  );
  let samplePromise = null;
  let readyPid = null;
  const maybeStartSampler = () => {
    const match = running.stderr.match(/Warm workload ready; pid=(\d+)/u);
    if (job.kind === "native" && match && !samplePromise) {
      readyPid = Number(match[1]);
      assert.equal(readyPid, running.child.pid, `${id}: ready marker PID differs from child`);
      samplePromise = sampleProcess(readyPid, join(jobRoot, "native.sample.txt"));
    }
  };
  running.child.stderr.on("data", maybeStartSampler);
  const childResult = await new Promise((resolvePromise, rejectPromise) => {
    running.child.on("error", rejectPromise);
    running.child.on("close", (code, signal) => resolvePromise({ code, signal }));
  });
  const sampleResult = samplePromise ? await samplePromise : null;
  await writeFile(join(jobRoot, "run.stdout.json"), running.stdout);
  await writeFile(join(jobRoot, "run.stderr.log"), running.stderr);
  if (sampleResult)
    await writeFile(join(jobRoot, "sample.stderr.log"), sampleResult.stderr + sampleResult.stdout);
  assert.equal(
    childResult.code,
    0,
    `${id}: profile worker exited ${childResult.code ?? childResult.signal}`,
  );
  assert.ok(running.stderr.includes("Warm workload ready"), `${id}: missing warm-workload marker`);
  if (job.kind === "native") assert.equal(sampleResult?.code, 0, `${id}: macOS sample failed`);
  const runReport = JSON.parse(running.stdout);
  const profileFiles = job.kind === "js" ? ["cpu-profile.json"] : [];
  if (job.kind === "js") {
    assert.equal(
      runReport.cpuProfile?.path,
      cpuProfilePath,
      `${id}: in-loop CPU profile was not reported`,
    );
    assert.ok(runReport.cpuProfile.nodes > 0, `${id}: CPU profile has no nodes`);
  }
  const artifactPaths = [...(job.kind === "native" ? ["native.sample.txt"] : []), ...profileFiles];
  const artifacts = [];
  for (const name of artifactPaths) {
    const path = join(jobRoot, name);
    const bytes = await readFile(path);
    artifacts.push({ path: `${id}/${name}`, bytes: bytes.length, sha256: digest(bytes) });
  }
  if (job.kind === "native") {
    const sampleInfo = await stat(join(jobRoot, "native.sample.txt"));
    assert.ok(sampleInfo.size > 0, `${id}: native sample output is empty`);
  }
  assert.deepEqual(
    await identitySnapshot(),
    initialIdentity,
    `${id}: addon, assets, harness, corpus, dependencies, or source reports changed during capture`,
  );
  return {
    id,
    ...job,
    status: "captured",
    worker: childResult,
    sampler: sampleResult ? { code: sampleResult.code, signal: sampleResult.signal } : null,
    readyPid,
    workload: runReport.workload,
    validation: runReport.validation,
    iterations: runReport.iterations,
    artifacts,
  };
}

const captures = [];
for (const job of jobs) {
  process.stderr.write(`[capture-prism-profiles] ${job.kind} ${job.engine}/${job.language}\n`);
  captures.push(await runJob(job));
}
const finalIdentity = await identitySnapshot();
assert.deepEqual(finalIdentity, initialIdentity, "Profile inputs changed across the capture set");

const unsupported = languages
  .filter((language) => !language.prism)
  .map((language) => ({
    id: `js-prism-${language.textmate}`,
    engine: "prism",
    language: language.textmate,
    status: "unsupported",
    reason: `Pinned Prism ${prismVersion} has no ${language.textmate} component.`,
  }));

const index = {
  schema: 1,
  capturedAt: new Date().toISOString(),
  revision: {
    commit: matrix.revision.commit,
    timingRuntimeCommit: ordinary.runtimeSourceCommit,
    profileRuntimeCommit: profileReceipt.ferriki.commit,
    status: "profile build and captures were made after the ordinary timing reports",
  },
  machine: {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    cpu: os.cpus()[0]?.model ?? null,
    os: `${os.type()} ${os.release()}`,
  },
  timingBinary: ordinary.ordinaryBinarySha256,
  profileBinary: profileReceipt.binarySha256,
  profileAddonPath: loadedAddon,
  profileBuild: profileReceipt,
  profileHarness: {
    captureScriptSha256: sha256(await readFile(scriptPath)),
    workerSha256: sha256(await readFile(join(nodeRoot, "scripts/profile-tiobe.mjs"))),
    measuredOutputModeHarnessSha256: measuredModeHarnessSha256,
    formattedOutputModeHarnessSha256: sha256(
      await readFile(join(nodeRoot, "scripts/bench-prism-output-modes.mjs")),
    ),
    formattedOutputModeHarnessChange:
      "The working harness was Oxfmt-formatted after timing; the archived pre-format source matches the recorded measured hash.",
    corpusManifestSha256: sha256(
      await readFile(join(nodeRoot, "benchmarks/curated/manifest.json")),
    ),
  },
  identityGuard: {
    checks: "Before and after each profile worker, and across the full capture set, hash the loaded addon, build receipt, release assets, harnesses, dependency manifests, source fixtures, and timing receipts.",
    inputs: finalIdentity,
  },
  method: {
    workload:
      "Curated corpus large input (16 repeated fixture copies), warmed HTML call, validation and setup complete before capture.",
    js: `Node Inspector CPU profiling starts after warmup immediately before the ${seconds}s render loop; setup and output validation are excluded. These are diagnostic profiles, not performance timings.`,
    native: `macOS sample attaches to the ready Ferriki native-boundary worker for ${sampleSeconds}s; profile binary uses line tables and is never used for timing claims.`,
  },
  captures,
  unsupported,
};
await writeFile(join(outputRoot, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`Wrote ${join(outputRoot, "index.json")}`);
