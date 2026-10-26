// Profile existing production entry points; phase clocks stay in a separate Rust probe.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { comparisonCorpus } from "./shiki-comparison-corpus.mjs";
import { TEST_ASSET_CACHE_DIR } from "./test-asset-env.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = [
  {
    id: "repository",
    documents: comparisonCorpus.map(([lang, path]) => {
      const code = readFileSync(join(repo, path), "utf8");
      return { lang, path, code, sha256: hash(code) };
    }),
  },
];
const inputsPath = join(out, "inputs.json");
writeFileSync(inputsPath, JSON.stringify(inputs, null, 2));
const worker = join(repo, "docs/benchmarks/precompiled-patterns/decoded-cache/reproduce.mjs");
const cache = process.env.FERRIKI_CACHE_DIR ?? TEST_ASSET_CACHE_DIR;
const run = (program, args) => {
  const child = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout);
};
const nodeRun = (mode) =>
  run(process.execPath, [
    worker,
    "--worker",
    join(repo, "node/ferriki/index.mjs"),
    inputsPath,
    "repository",
    mode,
    cache,
  ]);
// Seed decoded containers and verification receipts, outside every timer.
nodeRun("prepared");
const release = JSON.parse(readFileSync(join(repo, "assets/standard/release-manifest.json")));
const catalog = JSON.parse(readFileSync(join(repo, "assets/catalog.json"))).languages.entries;
const entries = new Map(catalog.map((entry) => [entry.id, entry]));
const preparedIds = new Set();
const pending = inputs[0].documents.map((doc) => [doc.lang, true]);
const visited = new Set();
while (pending.length) {
  const [id, prepared] = pending.pop();
  const visit = `${id}:${prepared}`;
  if (visited.has(visit)) continue;
  visited.add(visit);
  const asset = release.assets[`languages/${id}.fkbc`];
  if (prepared && asset) preparedIds.add(id);
  const delegated = prepared && asset && asset.formatVersion >>> 24 >= 3;
  pending.push(...(entries.get(id)?.embedded_langs ?? []).map((id) => [id, delegated]));
}
const archives = [...preparedIds].map((language) => {
  const decoded = release.assets[`languages/${language}.fkbc`].decoded;
  const path = join(cache, "decoded", decoded.sha256);
  const bytes = readFileSync(path);
  assert.equal(hash(bytes), decoded.sha256);
  assert.equal(bytes.length, decoded.size);
  const stamp = JSON.parse(readFileSync(`${path}.verified`));
  const metadata = statSync(path, { bigint: true });
  assert.equal(BigInt(stamp.size), metadata.size);
  assert.equal(
    BigInt(stamp.modified_secs) * 1_000_000_000n + BigInt(stamp.modified_nanos),
    metadata.mtimeNs,
  );
  const indexPath = `${path}.index-v1`;
  const index = readFileSync(indexPath);
  const indexStamp = JSON.parse(readFileSync(`${indexPath}.verified`));
  const indexMetadata = statSync(indexPath, { bigint: true });
  assert.equal(BigInt(indexStamp.size), indexMetadata.size);
  assert.equal(
    BigInt(indexStamp.modified_secs) * 1_000_000_000n + BigInt(indexStamp.modified_nanos),
    indexMetadata.mtimeNs,
  );
  return {
    language,
    path,
    bytes: decoded.size,
    sha256: decoded.sha256,
    indexBytes: index.length,
    indexSha256: hash(index),
  };
});
const archivePath = join(out, "archives.json");
writeFileSync(archivePath, JSON.stringify(archives, null, 2));
const modes = ["off", "auto", "eager", "prepared"];
const nodeRows = [];
for (let repeat = 0; repeat < 5; repeat++) {
  for (const mode of [...modes.slice(repeat % 4), ...modes.slice(0, repeat % 4)]) {
    const row = nodeRun(mode);
    if (nodeRows.length) assert.deepEqual(row.outputHashes, nodeRows[0].outputHashes);
    if (mode === "prepared") {
      assert.equal(row.diagnostics.preparedArchives, archives.length);
      assert.ok(row.diagnostics.preparedBytesRead > 0);
      assert.ok(row.diagnostics.preparedBytesRead < archives.reduce((n, a) => n + a.bytes, 0));
    } else {
      assert.equal(row.diagnostics.preparedBytesRead, 0);
    }
    nodeRows.push({ repeat, ...row });
    console.log(
      `${mode} #${repeat}: setup=${row.setupMs.toFixed(2)} first=${row.firstMs.toFixed(2)}`,
    );
  }
}
const probe = join(
  repo,
  "benchmarks/prepared-startup-profile/target/release/ferriki-prepared-startup-profile",
);
const rustRows = [];
const readers = ["take", "file", "exact"];
for (let repeat = 0; repeat < 5; repeat++) {
  for (const reader of [...readers.slice(repeat % 3), ...readers.slice(0, repeat % 3)]) {
    rustRows.push({ repeat, ...run(probe, [archivePath, reader]) });
  }
}
assert.ok(rustRows.every((row) => !row.phaseClocks));
const nativeBuild = JSON.parse(readFileSync(join(repo, "node/ferriki/.benchmark-build.json")));
assert.equal(nativeBuild.ferroni.version, "2.7.2");
assert.ok(!nativeBuild.ferroni.features.includes("scanner-load-profile"));
const result = {
  capturedAt: new Date().toISOString(),
  cpu: os.cpus()[0].model,
  os: `${os.platform()} ${os.release()}`,
  node: process.version,
  nativeBuild,
  probeSha256: hash(readFileSync(probe)),
  probeCargoLockSha256: hash(
    readFileSync(join(repo, "benchmarks/prepared-startup-profile/Cargo.lock")),
  ),
  inputsSha256: hash(readFileSync(inputsPath)),
  decodedBytes: archives.reduce((n, a) => n + a.bytes, 0),
  nodeRows,
  rustRows,
};
writeFileSync(join(out, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
