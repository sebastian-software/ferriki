// Join independent corpus VMs without mixing the engines within a comparison.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { comparisonCorpora, validateReport, writeEvidence } from "./run-blacksmith-comparison.mjs";

const json = (bytes) => JSON.parse(bytes.toString("utf8"));

export function validateCorpusProvenance(report, corpus, context) {
  assert.equal(context.status, "", "Dirty source workspace");
  assert.equal(context.nativeBuild.ferriki.status, "", "Dirty native build");
  assert.equal(context.nativeBuild.ferriki.commit, context.commit);
  if (context.comparators) assert.equal(report.versions.shiki, context.comparators.shiki);
  if (corpus === "comparison") {
    assert.equal(report.source.revision, context.commit);
    assert.equal(report.source.workingTreeClean, true);
    assert.equal(report.source.tree, context.tree);
  } else {
    if (context.comparators) assert.equal(report.versions.prism, context.comparators.prismjs);
    assert.equal(report.revision.commit, context.commit);
    assert.equal(report.revision.status, "");
    assert.equal(report.nativeBuild.binarySha256, context.nativeBuild.binarySha256);
    assert.equal(report.nativeBuild.rustSourceSha256, context.nativeBuild.rustSourceSha256);
  }
}

export function readShard(directory) {
  const original = new Map();
  const checksums = join(
    directory,
    existsSync(join(directory, "SHA256SUMS")) ? "SHA256SUMS" : "ORIGINAL_SHA256SUMS",
  );
  for (const line of readFileSync(checksums, "utf8").trim().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    assert.ok(match, "Invalid shard checksum record");
    const [, hash, name] = match;
    assert.ok(!name.startsWith("/") && !name.split("/").includes(".."));
    assert.ok(!original.has(name), `Duplicate shard file: ${name}`);
    const path = join(directory, name);
    const bytes = existsSync(path) ? readFileSync(path) : gunzipSync(readFileSync(`${path}.gz`));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      hash,
      `Artifact changed: ${name}`,
    );
    original.set(name, bytes);
  }
  assert.equal(json(original.get("validation.json")).ok, true, "Failed corpus shard");
  const context = json(original.get("context.json"));
  assert.equal(context.corpora.length, 1, "Expected one corpus per VM");
  const [corpus] = context.corpora;
  assert.ok(comparisonCorpora.includes(corpus), "Unknown corpus shard");
  const reports = {};
  for (const mode of ["on", "off"]) {
    const name = `${corpus}-${mode}`;
    const report = json(original.get(`${name}.json`));
    validateReport(report, corpus, mode === "on");
    validateCorpusProvenance(report, corpus, context);
    assert.ok(original.has(`logs/${name}.log`), "Missing process log");
    reports[name] = report;
  }
  return { original, context, corpus, reports };
}

function sharedInputs(context) {
  const { nativeBuild } = context;
  return {
    ...Object.fromEntries(
      [
        "profile",
        "runnerLabel",
        "runUrl",
        "runAttempt",
        "commit",
        "tree",
        "cpu",
        "cores",
        "platform",
        "os",
        "node",
        "rustc",
        "cargoLockSha256",
        "pnpmLockSha256",
        "comparators",
      ].map((key) => [key, context[key]]),
    ),
    rustSourceSha256: nativeBuild.rustSourceSha256,
    ferroni: Object.fromEntries(
      ["version", "source", "revision", "sourceSha256", "features"].map((key) => [
        key,
        nativeBuild.ferroni[key],
      ]),
    ),
    build: Object.fromEntries(
      ["rustflags", "encodedRustflags", "targetRustflags", "cargoProfileEnv"].map((key) => [
        key,
        nativeBuild[key],
      ]),
    ),
  };
}

export function mergeShards(directory, sources) {
  assert.equal(sources.length, comparisonCorpora.length, "Expected all three corpus shards");
  const shards = sources.map(readShard);
  const byCorpus = new Map(shards.map((shard) => [shard.corpus, shard]));
  assert.equal(byCorpus.size, comparisonCorpora.length, "Duplicate corpus shard");
  const reference = sharedInputs(shards[0].context);
  for (const shard of shards)
    assert.deepEqual(
      sharedInputs(shard.context),
      reference,
      "Corpus shards have different build inputs or runner profiles",
    );

  const corpusContexts = Object.fromEntries(
    comparisonCorpora.map((corpus) => [corpus, byCorpus.get(corpus).context]),
  );
  const context = {
    ...corpusContexts.comparison,
    corpora: comparisonCorpora,
    corpusContexts,
    schedule:
      "Separate VM per corpus; all engines and both prefilter modes share that corpus VM. No cross-VM or cross-corpus timing aggregate.",
  };
  const reports = Object.assign({}, ...shards.map((shard) => shard.reports));
  mkdirSync(join(directory, "contexts"), { recursive: true });
  mkdirSync(join(directory, "logs"), { recursive: true });
  writeFileSync(join(directory, "context.json"), `${JSON.stringify(context, null, 2)}\n`);
  for (const { corpus, original } of shards) {
    writeFileSync(join(directory, "contexts", `${corpus}.json`), original.get("context.json"));
    for (const mode of ["on", "off"]) {
      for (const name of [`${corpus}-${mode}.json`, `logs/${corpus}-${mode}.log`])
        writeFileSync(join(directory, name), original.get(name));
    }
  }
  writeEvidence(directory, reports, context);
  return { context, reports };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv.length,
    6,
    "Usage: node scripts/merge-blacksmith-comparison.mjs OUTPUT COMPARISON CURATED TIOBE",
  );
  mergeShards(
    resolve(process.argv[2]),
    process.argv.slice(3).map((path) => resolve(path)),
  );
}
