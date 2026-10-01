// Full highlighting workloads for evaluating Ferroni changes through Ferriki.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveFerrikiPlatformTarget } from "../ferriki/platforms.mjs";
import {
  createEngine,
  engines,
  loadCases,
  loadCorpus,
  plain,
  repoRoot,
  sha256,
  statistics,
  theme,
  validateOutput,
} from "./tiobe-benchmark.mjs";

const script = fileURLToPath(import.meta.url);
const nodeRoot = join(repoRoot, "node");
const options = {
  corpus: { type: "string", default: "tiobe" },
  write: { type: "string" },
  language: { type: "string" },
  sizes: { type: "string", default: "example,large" },
  "budget-ms": { type: "string", default: "300" },
  rounds: { type: "string", default: "30" },
  "max-rounds": { type: "string", default: "1000" },
  "timeout-ms": { type: "string", default: "120000" },
  help: { type: "boolean" },
  worker: { type: "string" },
};
const { values } = parseArgs({ options });
if (values.help) {
  console.log(
    "Usage: pnpm bench:tiobe [--corpus tiobe|curated] [--write report.json] [--language rust] [--sizes example,large] [--budget-ms 300] [--rounds 30] [--max-rounds 1000] [--timeout-ms 120000]",
  );
  process.exit(0);
}
const manifest = loadCorpus(values.corpus);
const integer = (name, min, max) => {
  const number = Number(values[name]);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`Invalid --${name}: expected an integer in ${min}..${max}`);
  return number;
};
const method = {
  theme,
  apis: ["html", "tokens"],
  sizes: values.sizes.split(","),
  warmup: 5,
  budgetMsPerEngine: integer("budget-ms", 0, 10000),
  minRounds: integer("rounds", 1, 1000),
  maxRounds: integer("max-rounds", 1, 10000),
  timeoutMsPerLanguage: integer("timeout-ms", 1, 600000),
  schedule:
    "Rotate engine order every round; warm reused highlighters; one process per language; sequential languages",
  units:
    "Milliseconds per document; raw samples include output allocation; setup and validation excluded",
};
if (method.maxRounds < method.minRounds) throw new Error("--max-rounds must be at least --rounds");
if (
  new Set(method.sizes).size !== method.sizes.length ||
  method.sizes.some((size) => !["example", "large"].includes(size))
)
  throw new Error("--sizes must contain example and/or large once");

// Worker timeout covers imports, grammar compilation, validation and measurement.
// A hanging regex cannot freeze the entire corpus or disappear from the report.
async function worker(language) {
  const highlighters = {};
  const setup = {};
  for (const id of engines) {
    if (id === "prism" && !language.prism) {
      setup[id] = { status: "unsupported", reason: language.prismUnsupported };
      continue;
    }
    const start = performance.now();
    try {
      highlighters[id] = await createEngine(id, language);
      setup[id] = { status: "ok", importAndSetupMs: performance.now() - start };
    } catch (error) {
      setup[id] = { status: "error", error: String(error) };
    }
  }
  const cases = [];
  let consumed = 0;
  try {
    for (const { code, ...entry } of loadCases(language, method.sizes, values.corpus)) {
      const results = plain(setup);
      let reference;
      try {
        reference = {
          tokens: plain(highlighters["shiki-wasm"].tokens(code)),
          html: highlighters["shiki-wasm"].html(code),
        };
      } catch (error) {
        throw new Error(`Shiki WASM oracle unavailable: ${error}`);
      }
      for (const id of engines.filter((id) => highlighters[id])) {
        try {
          const tokens = highlighters[id].tokens(code);
          const html = highlighters[id].html(code);
          results[id].validation = validateOutput(id, code, tokens, html, reference);
        } catch (error) {
          results[id] = { status: "error", error: String(error) };
        }
      }
      const timed = engines.filter((id) => results[id].status === "ok");
      for (const api of method.apis) {
        const samples = Object.fromEntries(timed.map((id) => [id, []]));
        for (let round = 0; round < method.warmup; round++) {
          for (const id of timed) consumed += highlighters[id][api](code).length;
        }
        const started = performance.now();
        let round = 0;
        while (
          timed.length &&
          round < method.maxRounds &&
          (round < method.minRounds ||
            performance.now() - started < method.budgetMsPerEngine * timed.length)
        ) {
          for (let offset = 0; offset < timed.length; offset++) {
            const id = timed[(round + offset) % timed.length];
            const start = performance.now();
            const output = highlighters[id][api](code);
            samples[id].push(performance.now() - start);
            consumed += output.length;
          }
          round++;
        }
        for (const id of timed) results[id][api] = statistics(samples[id], entry.bytes);
      }
      cases.push({ ...entry, results });
    }
    return { ...language, cases, consumed };
  } finally {
    for (const highlighter of Object.values(highlighters)) highlighter.dispose();
  }
}

if (values.worker) {
  const language = manifest.languages.find((entry) => entry.rank === Number(values.worker));
  if (!language?.file) throw new Error("Invalid worker rank");
  const output = JSON.stringify(await worker(language));
  // Await the pipe flush: process.exit can otherwise truncate large raw reports.
  await new Promise((done, reject) =>
    process.stdout.write(output, (error) => (error ? reject(error) : done())),
  );
  process.exit(0);
}

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}
function nativeBuild() {
  const receipt = JSON.parse(readFileSync(join(nodeRoot, "ferriki/.benchmark-build.json"), "utf8"));
  const require = createRequire(new URL("../ferriki/native.mjs", import.meta.url));
  const target = resolveFerrikiPlatformTarget();
  if (!target) throw new Error("No supported native platform");
  const candidates = [
    `${target.packageName}/ferriki.node`,
    join(nodeRoot, "ferriki/dist", target.binaryName),
    join(nodeRoot, "ferriki/dist/ferriki.node"),
    join(nodeRoot, "ferriki/ferriki.node"),
  ];
  for (const candidate of candidates) {
    let addon;
    try {
      addon = require.resolve(candidate);
      require(addon);
    } catch {
      continue;
    }
    if (sha256(readFileSync(addon)) !== receipt.binarySha256)
      throw new Error(
        `Native addon differs from the build receipt: ${addon}. Rebuild with pnpm build:native.`,
      );
    return { ...receipt, loadedAddon: addon };
  }
  throw new Error("No native addon available. Run pnpm build:native first.");
}

const selected = manifest.languages.filter(
  (language) =>
    !values.language ||
    [language.name, language.textmate, String(language.rank)].includes(values.language),
);
if (!selected.length) throw new Error(`Unknown --language ${values.language}`);
const native = nativeBuild();
const report = {
  schema: 1,
  measuredAt: new Date().toISOString(),
  revision: { commit: git("rev-parse", "HEAD"), status: git("status", "--porcelain") },
  nativeBuild: native,
  assetManifestSha256: sha256(
    readFileSync(join(nodeRoot, "ferriki/assets/shiki/release-manifest.json")),
  ),
  harnessSha256: sha256(
    readFileSync(script) + readFileSync(new URL("./tiobe-benchmark.mjs", import.meta.url)),
  ),
  corpus: {
    id: values.corpus,
    name: manifest.name ?? `TIOBE ${manifest.month}`,
    month: manifest.month,
    source: manifest.source,
    manifestSha256: sha256(JSON.stringify(manifest)),
  },
  versions: Object.fromEntries(
    [
      ["ferriki", "ferriki"],
      ["shiki", "node_modules/shiki"],
      ["prism", "node_modules/prismjs"],
    ].map(([id, path]) => [
      id,
      JSON.parse(readFileSync(join(nodeRoot, path, "package.json"), "utf8")).version,
    ]),
  ),
  machine: {
    cpu: os.cpus()[0]?.model,
    cores: os.availableParallelism(),
    platform: `${process.platform}-${process.arch}`,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  },
  method,
  languages: [],
};
for (const language of selected) {
  let row = { ...language, status: "unsupported" };
  if (language.file) {
    process.stderr.write(`${language.rank}. ${language.name}\n`);
    const childArgs = Object.entries(values)
      .filter(([key]) => !["write", "language", "worker"].includes(key))
      .flatMap(([key, value]) => [`--${key}`, value]);
    const child = spawnSync(
      process.execPath,
      [script, "--worker", String(language.rank), ...childArgs],
      {
        cwd: nodeRoot,
        env: { ...process.env, FERRIKI_ASSETS_REMOTE: "0" },
        encoding: "utf8",
        timeout: method.timeoutMsPerLanguage,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (child.status === 0) {
      try {
        row = { ...JSON.parse(child.stdout), status: "measured" };
      } catch (error) {
        row = { ...language, status: "error", error: `Invalid worker report: ${error}` };
      }
    } else {
      row = {
        ...language,
        status: child.error?.code === "ETIMEDOUT" ? "timeout" : "error",
        error: child.error?.message ?? child.stderr.trim(),
      };
    }
  }
  report.languages.push(row);
  // Retain completed languages even if a later worker is interrupted.
  if (values.write) writeFileSync(resolve(values.write), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
