// Measures native addon size and cold `require()` time in fresh processes
// (#225). CI runs it on every sidecar target and compares the fresh build with
// the latest published sidecar, so all seven targets are covered without
// cross-platform tooling. Markdown goes to stdout; progress to stderr.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const { values } = parseArgs({
  options: {
    addon: { type: "string", multiple: true, default: [] },
    published: { type: "string" },
    runs: { type: "string", default: "30" },
    write: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/measure-native-load.mjs --addon name=path [--addon ...] [--published <platform-id>] [--runs 30] [--write report.json]",
  );
  process.exit(0);
}
const runs = Number(values.runs);
assert.ok(Number.isInteger(runs) && runs > 0, "Invalid --runs");
const addons = values.addon.map((spec) => {
  const [name, ...rest] = spec.split("=");
  assert.ok(name && rest.length, `Invalid --addon ${spec}`);
  return { name, path: resolve(rest.join("=")) };
});

/**
 * Reads one file from a gzipped ustar archive such as an npm tarball. An
 * external `tar` is not portable: the Git Bash `tar` on Windows reads `D:` paths as remote hosts.
 */
function tarEntry(archive, wanted) {
  const tar = gunzipSync(readFileSync(archive));
  const text = (start, length) => tar.toString("utf8", start, start + length).replace(/\0.*$/s, "");
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = text(offset, 100);
    if (!name) break;
    const prefix = text(offset + 345, 155);
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
    const body = offset + 512;
    if ((prefix ? `${prefix}/${name}` : name) === wanted) return tar.subarray(body, body + size);
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} is missing from ${archive}`);
}

let scratch;
if (values.published) {
  // The published sidecar is the release baseline for the same target.
  const spec = `@ferriki/${values.published}@latest`;
  scratch = mkdtempSync(join(tmpdir(), "ferriki-load-"));
  const pack = spawnSync("npm", ["pack", spec, "--json", "--pack-destination", scratch], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (pack.status === 0) {
    const [{ filename, version }] = JSON.parse(pack.stdout);
    const addon = join(scratch, "ferriki.node");
    writeFileSync(addon, tarEntry(join(scratch, filename), "package/ferriki.node"));
    addons.push({ name: `published ${version}`, path: addon });
  } else {
    console.error(`[load] ${spec} is unavailable; measuring the local addons only.`);
  }
}
assert.ok(addons.length, "Pass at least one --addon");

// Dependency-free, so the script runs before any workspace package is built.
function quantile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}

function coldRequireMs(path) {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "const t=performance.now();require(process.argv[1]);console.log(performance.now()-t)",
      path,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  return Number(child.stdout);
}

// One discarded load per addon warms the file cache; the rest alternate.
for (const addon of addons) coldRequireMs(addon.path);
const samples = addons.map(() => []);
for (let run = 0; run < runs; run++)
  for (let k = 0; k < addons.length; k++) {
    const index = (run + k) % addons.length;
    samples[index].push(coldRequireMs(addons[index].path));
  }
const results = addons.map((addon, index) => ({
  ...addon,
  bytes: statSync(addon.path).size,
  sha256: createHash("sha256").update(readFileSync(addon.path)).digest("hex"),
  coldRequireMs: {
    median: quantile(samples[index], 0.5),
    p90: quantile(samples[index], 0.9),
    min: Math.min(...samples[index]),
    samples: samples[index],
  },
}));
if (scratch) rmSync(scratch, { recursive: true, force: true });

const target = `${process.platform}-${process.arch}`;
const report = { node: process.version, target, runs, results };
if (values.write) writeFileSync(values.write, `${JSON.stringify(report, null, 2)}\n`);
const base = results.at(-1);
const change = (value, reference) =>
  results.length > 1 ? ` (${(((value - reference) / reference) * 100).toFixed(2)}%)` : "";
console.log(`### Native addon size and cold require (${target}, Node ${process.version})\n`);
console.log("| Addon | Bytes | Cold require median (ms) | p90 (ms) |");
console.log("| --- | ---: | ---: | ---: |");
for (const result of results)
  console.log(
    `| ${result.name} | ${result.bytes}${change(result.bytes, base.bytes)} | ${result.coldRequireMs.median.toFixed(3)}${change(result.coldRequireMs.median, base.coldRequireMs.median)} | ${result.coldRequireMs.p90.toFixed(3)} |`,
  );
console.log(
  `\n${runs} fresh processes per addon in alternating order; the time covers only \`require()\` of the addon.`,
);
