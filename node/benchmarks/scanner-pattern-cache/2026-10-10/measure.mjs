import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

const languages = ["cpp", "typescript", "tsx", "json", "astro"];
const variants = ["base", "candidate"];
const warmupCalls = 5;
const measuredWarmCalls = 30;

if (process.argv[2] === "worker") {
  const [, , , rootArg, language] = process.argv;
  const root = resolve(rootArg);
  const manifest = JSON.parse(
    readFileSync(join(root, "node/benchmarks/curated/manifest.json"), "utf8"),
  );
  const entry = manifest.languages.find((item) => item.textmate === language);
  if (!entry || !languages.includes(language)) throw new Error(`Unknown fixture ${language}`);
  const codePath = join(root, "node/benchmarks/curated/fixtures", entry.file);
  const code = readFileSync(codePath, "utf8");
  const memory = () => {
    if (globalThis.gc) globalThis.gc();
    const usage = process.memoryUsage();
    return {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
    };
  };
  const digest = (text) => createHash("sha256").update(text).digest("hex");

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
  await new Promise((done) => process.stdout.write(`${JSON.stringify(result)}\n`, done));
  process.exit(0);
}

if (process.argv[2] === "memory-worker") {
  const [, , , rootArg] = process.argv;
  const root = resolve(rootArg);
  const manifest = JSON.parse(
    readFileSync(join(root, "node/benchmarks/curated/manifest.json"), "utf8"),
  );
  const memory = () => {
    if (globalThis.gc) globalThis.gc();
    const usage = process.memoryUsage();
    return {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
    };
  };
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  const native = createRequire(import.meta.url)(join(root, "node/ferriki/ferriki.node"));
  const highlighter = native.createHighlighter({
    standardAssetRoot: join(root, "node/ferriki/assets/shiki"),
    assets: { remote: false, cacheDir: join(root, "node/.cache/ferriki-assets") },
  });
  highlighter.loadStandardTheme("github-dark");
  const checkpoints = [{ loadedLanguages: [], memory: memory() }];
  const html = {};
  for (const language of languages) {
    const entry = manifest.languages.find((item) => item.textmate === language);
    const code = readFileSync(join(root, "node/benchmarks/curated/fixtures", entry.file), "utf8");
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
  await new Promise((done) =>
    process.stdout.write(
      `${JSON.stringify({ languages, htmlSha256: html, checkpoints, afterDispose: memory() })}\n`,
      done,
    ),
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
const buildReceipts = Object.fromEntries(
  variants.map((variant) => [
    variant,
    JSON.parse(readFileSync(join(roots[variant], "node/ferriki/.benchmark-build.json"), "utf8")),
  ]),
);
if (buildReceipts.base.ferroni.version !== buildReceipts.candidate.ferroni.version)
  throw new Error("Base and candidate Ferroni versions differ");
if (buildReceipts.base.cargoLockSha256 !== buildReceipts.candidate.cargoLockSha256)
  throw new Error("Base and candidate Cargo.lock fingerprints differ");
const sourcePaths = ["adr/0010-mechanical-vscode-textmate-port.md", "crates/ferriki-textmate/src"];
const sourceDiff = spawnSync(
  "git",
  ["diff", "--binary", buildReceipts.base.ferriki.commit, "--", ...sourcePaths],
  { cwd: roots.candidate, encoding: null, maxBuffer: 32 * 1024 * 1024 },
);
if (sourceDiff.status !== 0)
  throw new Error(sourceDiff.stderr?.toString("utf8") ?? sourceDiff.error?.message);
const sourcePathList = spawnSync(
  "git",
  ["diff", "--name-only", buildReceipts.base.ferriki.commit, "--", ...sourcePaths],
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
