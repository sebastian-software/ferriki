import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const languages = ["cpp", "typescript", "tsx", "json", "astro"];
const variants = ["base", "candidate"];
const warmupCalls = 5;
const measuredWarmCalls = 30;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function captureInputs(root, fixtureLanguages = languages) {
  const receiptBytes = readFileSync(join(root, "node/ferriki/.benchmark-build.json"));
  const receipt = JSON.parse(receiptBytes);
  const addonBytes = readFileSync(join(root, "node/ferriki/ferriki.node"));
  const fixtureManifestBytes = readFileSync(join(root, "node/benchmarks/curated/manifest.json"));
  const assetManifestBytes = readFileSync(
    join(root, "node/ferriki/assets/shiki/release-manifest.json"),
  );
  const manifest = JSON.parse(fixtureManifestBytes);
  const fixtureFiles = Object.fromEntries(
    fixtureLanguages.map((language) => {
      const entry = manifest.languages.find((item) => item.textmate === language);
      if (!entry) throw new Error(`Unknown fixture ${language}`);
      const path = `node/benchmarks/curated/fixtures/${entry.file}`;
      const bytes = readFileSync(join(root, path));
      return [
        language,
        {
          path,
          bytes: bytes.length,
          sha256: digest(bytes),
          code: bytes.toString("utf8"),
        },
      ];
    }),
  );
  const guard = {
    receiptSha256: digest(receiptBytes),
    receiptCommit: receipt.ferriki.commit,
    receiptStatus: receipt.ferriki.status,
    receiptBinarySha256: receipt.binarySha256,
    actualAddonSha256: digest(addonBytes),
    fixtureManifestSha256: digest(fixtureManifestBytes),
    assetManifestSha256: digest(assetManifestBytes),
    fixtures: Object.fromEntries(
      Object.entries(fixtureFiles).map(([language, { path, bytes, sha256 }]) => [
        language,
        { path, bytes, sha256 },
      ]),
    ),
  };

  return { guard, receipt, manifest, fixtureManifestBytes, assetManifestBytes, fixtureFiles };
}

function assertInputGuardMatches(actual, expected, fixtureLanguages, context) {
  for (const key of [
    "receiptSha256",
    "receiptCommit",
    "receiptStatus",
    "receiptBinarySha256",
    "actualAddonSha256",
    "fixtureManifestSha256",
    "assetManifestSha256",
  ]) {
    if (actual[key] !== expected[key]) throw new Error(`${context}: ${key} changed`);
  }
  for (const language of fixtureLanguages) {
    if (JSON.stringify(actual.fixtures[language]) !== JSON.stringify(expected.fixtures[language]))
      throw new Error(`${context}: ${language} fixture changed`);
  }
}

if (process.argv[2] === "worker") {
  const [, , , rootArg, language, expectedGuardJson] = process.argv;
  const root = resolve(rootArg);
  const expectedGuard = JSON.parse(expectedGuardJson);
  const inputs = captureInputs(root, [language]);
  assertInputGuardMatches(inputs.guard, expectedGuard, [language], `${language} worker`);
  const manifest = inputs.manifest;
  const entry = manifest.languages.find((item) => item.textmate === language);
  if (!entry || !languages.includes(language)) throw new Error(`Unknown fixture ${language}`);
  const code = inputs.fixtureFiles[language].code;
  const memory = () => {
    if (globalThis.gc) globalThis.gc();
    const usage = process.memoryUsage();
    return {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
    };
  };
  const started = performance.now();
  const native = createRequire(import.meta.url)(join(root, "node/ferriki/ferriki.node"));
  const loadedAddon = performance.now();
  const highlighter = native.createHighlighter({
    standardAssetRoot: join(root, "node/ferriki/assets/shiki"),
    assets: { remote: false, cacheDir: join(root, "node/.cache/ferriki-assets") },
  });
  const createdHighlighter = performance.now();
  highlighter.loadStandardTheme("github-dark");
  highlighter.loadStandardGrammar(language);
  const loadedGrammar = performance.now();
  const firstHtml = highlighter.codeToHtml(code, {
    lang: language,
    theme: "github-dark",
    tokenizeTimeLimit: 500,
  });
  const firstHtmlComplete = performance.now();
  const htmlSha256 = digest(firstHtml);
  const memoryAfterFirstHtml = memory();
  let measuredHtml = firstHtml;

  for (let index = 0; index < warmupCalls; index++) {
    measuredHtml = highlighter.codeToHtml(code, {
      lang: language,
      theme: "github-dark",
      tokenizeTimeLimit: 500,
    });
  }
  const warmSampleMs = [];
  for (let index = 0; index < measuredWarmCalls; index++) {
    const warmStart = performance.now();
    measuredHtml = highlighter.codeToHtml(code, {
      lang: language,
      theme: "github-dark",
      tokenizeTimeLimit: 500,
    });
    warmSampleMs.push(performance.now() - warmStart);
    if (digest(measuredHtml) !== htmlSha256)
      throw new Error("Warm HTML differs from first-use HTML");
  }

  const result = {
    language,
    fixture: entry.file,
    inputGuard: inputs.guard,
    fixtureBytes: Buffer.byteLength(code),
    outputBytes: Buffer.byteLength(firstHtml),
    htmlSha256,
    firstUse: {
      addonLoadMs: loadedAddon - started,
      highlighterCreateMs: createdHighlighter - loadedAddon,
      themeAndGrammarLoadMs: loadedGrammar - createdHighlighter,
      htmlRenderMs: firstHtmlComplete - loadedGrammar,
      totalMs: firstHtmlComplete - started,
    },
    warm: {
      warmupCalls,
      measuredCalls: measuredWarmCalls,
      sampleMs: warmSampleMs,
      medianMs: median(warmSampleMs),
    },
    memory: { afterGrammarAndFirstHtml: memoryAfterFirstHtml, afterWarmCalls: memory() },
  };
  highlighter.dispose();
  result.memory.afterDispose = memory();
  writeSync(1, `${JSON.stringify(result)}\n`);
  process.exit(0);
}

if (process.argv[2] === "memory-worker") {
  const [, , , rootArg, expectedGuardJson] = process.argv;
  const root = resolve(rootArg);
  const expectedGuard = JSON.parse(expectedGuardJson);
  const inputs = captureInputs(root);
  assertInputGuardMatches(inputs.guard, expectedGuard, languages, "memory worker");
  const memory = () => {
    if (globalThis.gc) globalThis.gc();
    const usage = process.memoryUsage();
    return {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
    };
  };
  const native = createRequire(import.meta.url)(join(root, "node/ferriki/ferriki.node"));
  const highlighter = native.createHighlighter({
    standardAssetRoot: join(root, "node/ferriki/assets/shiki"),
    assets: { remote: false, cacheDir: join(root, "node/.cache/ferriki-assets") },
  });
  highlighter.loadStandardTheme("github-dark");
  const checkpoints = [{ loadedLanguages: [], memory: memory() }];
  const html = {};
  for (const language of languages) {
    const code = inputs.fixtureFiles[language].code;
    highlighter.loadStandardGrammar(language);
    html[language] = digest(
      highlighter.codeToHtml(code, {
        lang: language,
        theme: "github-dark",
        tokenizeTimeLimit: 500,
      }),
    );
    checkpoints.push({ loadedLanguages: languages.slice(0, checkpoints.length), memory: memory() });
  }
  highlighter.dispose();
  writeSync(
    1,
    `${JSON.stringify({
      languages,
      inputGuard: inputs.guard,
      htmlSha256: html,
      checkpoints,
      afterDispose: memory(),
    })}\n`,
  );
  process.exit(0);
}

if (process.argv[2] !== "run") {
  throw new Error(
    "Usage: node measure.mjs run <base-root> <candidate-root> <output.json> [rounds]",
  );
}

const [, , , baseRootArg, candidateRootArg, outputArg, roundsArg = "9"] = process.argv;
const roots = {
  base: resolve(baseRootArg),
  candidate: resolve(candidateRootArg),
};
const outputPath = resolve(outputArg);
const rounds = Number(roundsArg);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("rounds must be a positive integer");
const buildReceiptInputs = Object.fromEntries(
  variants.map((variant) => {
    const bytes = readFileSync(join(roots[variant], "node/ferriki/.benchmark-build.json"));
    return [variant, { bytes, sha256: digest(bytes), receipt: JSON.parse(bytes) }];
  }),
);
const buildReceipts = Object.fromEntries(
  variants.map((variant) => [variant, buildReceiptInputs[variant].receipt]),
);
if (buildReceipts.base.ferroni.version !== buildReceipts.candidate.ferroni.version)
  throw new Error("Base and candidate Ferroni versions differ");
if (buildReceipts.base.cargoLockSha256 !== buildReceipts.candidate.cargoLockSha256)
  throw new Error("Base and candidate Cargo.lock fingerprints differ");
const sourcePaths = ["adr/0010-mechanical-vscode-textmate-port.md", "crates/ferriki-textmate/src"];
const sourceDiff = spawnSync(
  "git",
  [
    "diff",
    "--binary",
    buildReceipts.base.ferriki.commit,
    buildReceipts.candidate.ferriki.commit,
    "--",
    ...sourcePaths,
  ],
  { cwd: roots.candidate, encoding: null, maxBuffer: 32 * 1024 * 1024 },
);
if (sourceDiff.status !== 0)
  throw new Error(sourceDiff.stderr?.toString("utf8") ?? sourceDiff.error?.message);
const sourcePathList = spawnSync(
  "git",
  [
    "diff",
    "--name-only",
    buildReceipts.base.ferriki.commit,
    buildReceipts.candidate.ferriki.commit,
    "--",
    ...sourcePaths,
  ],
  { cwd: roots.candidate, encoding: "utf8" },
);
if (sourcePathList.status !== 0) throw new Error(sourcePathList.stderr);
const candidateSourceDiff = {
  baseCommit: buildReceipts.base.ferriki.commit,
  sha256: createHash("sha256").update(sourceDiff.stdout).digest("hex"),
  bytes: sourceDiff.stdout.length,
  paths: sourcePathList.stdout.split("\n").filter(Boolean),
  rustSourceSha256: buildReceipts.candidate.rustSourceSha256,
};
const inputSnapshotsBefore = Object.fromEntries(
  variants.map((variant) => [variant, captureInputs(roots[variant]).guard]),
);
for (const variant of variants) {
  const receipt = buildReceipts[variant];
  const guard = inputSnapshotsBefore[variant];
  if (guard.receiptSha256 !== buildReceiptInputs[variant].sha256)
    throw new Error(`${variant}: build receipt hash changed while capturing inputs`);
  if (receipt.ferriki.status !== "")
    throw new Error(`${variant}: build receipt describes a dirty Ferriki tree`);
  if (guard.receiptBinarySha256 !== receipt.binarySha256)
    throw new Error(`${variant}: receipt's addon hash does not match its binary hash`);
  if (guard.actualAddonSha256 !== receipt.binarySha256)
    throw new Error(`${variant}: actual addon bytes do not match the build receipt`);
}
for (const key of ["fixtureManifestSha256", "assetManifestSha256"]) {
  if (inputSnapshotsBefore.base[key] !== inputSnapshotsBefore.candidate[key])
    throw new Error(`Base and candidate ${key} differ`);
}
for (const language of languages) {
  if (
    JSON.stringify(inputSnapshotsBefore.base.fixtures[language]) !==
    JSON.stringify(inputSnapshotsBefore.candidate.fixtures[language])
  )
    throw new Error(`Base and candidate ${language} fixture hashes differ`);
}
const fixtureManifest = JSON.parse(
  readFileSync(join(roots.base, "node/benchmarks/curated/manifest.json"), "utf8"),
);
const fixtureManifestBytes = readFileSync(
  join(roots.base, "node/benchmarks/curated/manifest.json"),
);
const candidateFixtureManifestBytes = readFileSync(
  join(roots.candidate, "node/benchmarks/curated/manifest.json"),
);
if (!fixtureManifestBytes.equals(candidateFixtureManifestBytes))
  throw new Error("Base and candidate fixture manifests differ");
const assetManifestBytes = readFileSync(
  join(roots.base, "node/ferriki/assets/shiki/release-manifest.json"),
);
const candidateAssetManifestBytes = readFileSync(
  join(roots.candidate, "node/ferriki/assets/shiki/release-manifest.json"),
);
if (!assetManifestBytes.equals(candidateAssetManifestBytes))
  throw new Error("Base and candidate standard asset manifests differ");
const fixtures = Object.fromEntries(
  languages.map((language) => {
    const entry = fixtureManifest.languages.find((item) => item.textmate === language);
    const path = join(roots.base, "node/benchmarks/curated/fixtures", entry.file);
    const bytes = readFileSync(path);
    const candidateBytes = readFileSync(
      join(roots.candidate, "node/benchmarks/curated/fixtures", entry.file),
    );
    if (!bytes.equals(candidateBytes)) throw new Error(`${language} fixture differs by revision`);
    return [
      language,
      {
        path: `node/benchmarks/curated/fixtures/${entry.file}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ];
  }),
);

for (const variant of variants) {
  assertInputGuardMatches(
    captureInputs(roots[variant]).guard,
    inputSnapshotsBefore[variant],
    languages,
    `${variant} pre-capture recheck`,
  );
}

const samples = [];
for (let round = 0; round < rounds; round++) {
  for (let index = 0; index < languages.length; index++) {
    const language = languages[index];
    const first = (round + index) % 2 === 0 ? "base" : "candidate";
    for (const variant of [first, first === "base" ? "candidate" : "base"]) {
      samples.push({ round, variant, ...runWorker(variant, "worker", language) });
    }
  }
}

const memorySamples = [];
for (let round = 0; round < 5; round++) {
  const first = round % 2 === 0 ? "candidate" : "base";
  for (const variant of [first, first === "base" ? "candidate" : "base"]) {
    memorySamples.push({ round, variant, ...runWorker(variant, "memory-worker") });
  }
}

for (const sample of samples)
  assertInputGuardMatches(
    sample.inputGuard,
    inputSnapshotsBefore[sample.variant],
    [sample.language],
    `${sample.variant} ${sample.language} worker receipt`,
  );
for (const sample of memorySamples)
  assertInputGuardMatches(
    sample.inputGuard,
    inputSnapshotsBefore[sample.variant],
    languages,
    `${sample.variant} memory worker receipt`,
  );
const inputSnapshotsAfter = Object.fromEntries(
  variants.map((variant) => [variant, captureInputs(roots[variant]).guard]),
);
for (const variant of variants)
  assertInputGuardMatches(
    inputSnapshotsAfter[variant],
    inputSnapshotsBefore[variant],
    languages,
    `${variant} post-capture recheck`,
  );

const timingSummary = Object.fromEntries(
  languages.map((language) => [
    language,
    Object.fromEntries(
      variants.map((variant) => {
        const selected = samples.filter(
          (sample) => sample.language === language && sample.variant === variant,
        );
        return [
          variant,
          {
            firstUseMedianMs: median(selected.map((sample) => sample.firstUse.totalMs)),
            warmHtmlMedianMs: median(selected.map((sample) => sample.warm.medianMs)),
            rssAfterFirstHtmlMedianBytes: median(
              selected.map((sample) => sample.memory.afterGrammarAndFirstHtml.rssBytes),
            ),
            rssAfterWarmMedianBytes: median(
              selected.map((sample) => sample.memory.afterWarmCalls.rssBytes),
            ),
          },
        ];
      }),
    ),
  ]),
);
const memorySummary = Object.fromEntries(
  variants.map((variant) => {
    const selected = memorySamples.filter((sample) => sample.variant === variant);
    return [
      variant,
      {
        rssAfterFirstGrammarMedianBytes: median(
          selected.map((sample) => sample.checkpoints[1].memory.rssBytes),
        ),
        rssAfterFiveGrammarsMedianBytes: median(
          selected.map((sample) => sample.checkpoints.at(-1).memory.rssBytes),
        ),
        rssAfterDisposeMedianBytes: median(selected.map((sample) => sample.afterDispose.rssBytes)),
        externalAfterFiveGrammarsMedianBytes: median(
          selected.map((sample) => sample.checkpoints.at(-1).memory.externalBytes),
        ),
      },
    ];
  }),
);

for (const language of languages) {
  const checksums = new Set(
    samples.filter((sample) => sample.language === language).map((sample) => sample.htmlSha256),
  );
  const memoryChecksums = new Set(memorySamples.map((sample) => sample.htmlSha256[language]));
  if (checksums.size !== 1 || memoryChecksums.size !== 1)
    throw new Error(`HTML changed across base/candidate samples for ${language}`);
}

const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  hostCpu: os.cpus()[0]?.model ?? null,
  logicalCpuCount: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  machine: process.env.MACHINE_PROFILE ?? null,
  rounds,
  warmupCalls,
  measuredWarmCalls,
  memoryRounds: 5,
  memoryBoundary:
    "Fresh process, one highlighter/registry, one theme, then all five grammars loaded and highlighted in order; current RSS/heap/external snapshots after GC where available.",
  timingBoundary:
    "Fresh Node process per language/revision; timer starts before native addon require and stops after first HTML. Warm samples reuse the same highlighter and HTML fixture; process startup and filesystem reads are outside the timer.",
  baseCommit: buildReceipts.base.ferriki.commit,
  candidateCommit: buildReceipts.candidate.ferriki.commit,
  candidateSourceDiff,
  ferroniVersion: buildReceipts.base.ferroni.version,
  fixtureManifestSha256: createHash("sha256").update(fixtureManifestBytes).digest("hex"),
  assetManifestSha256: createHash("sha256").update(assetManifestBytes).digest("hex"),
  buildReceipts,
  inputSnapshotsBefore,
  inputSnapshotsAfter,
  fixtures,
  samples,
  memorySamples,
  timingSummary,
  memorySummary,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `Wrote ${outputPath} (${samples.length} HTML samples, ${memorySamples.length} memory samples)\n`,
);

function runWorker(variant, mode, language) {
  const args = [import.meta.filename, mode, roots[variant]];
  if (language) args.push(language);
  args.push(JSON.stringify(inputSnapshotsBefore[variant]));
  const result = spawnSync(process.execPath, ["--expose-gc", ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${variant} ${mode} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
