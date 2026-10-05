// Decomposes token calls into tokenizer, DTO, N-API conversion and facade
// work (#225). Builds ferriki-core with `--features profiling` into
// target/profiling unless --addon names such a build. Optional engines
// (`name=path`, or `name=json:path` for the napi-rs 2 binding) add JS heap
// bytes per result. --phases-only skips the production and facade timings.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { createHighlighter } from "../ferriki/index.mjs";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import { TEST_ASSET_CACHE_DIR } from "./test-asset-env.mjs";
import { loadCases, loadCorpus, quantile, repoRoot } from "./tiobe-benchmark.mjs";

const { values } = parseArgs({
  options: {
    addon: { type: "string" },
    engine: { type: "string", multiple: true, default: [] },
    repeat: { type: "string", default: "15" },
    themes: { type: "string", default: "single,multi" },
    sizes: { type: "string", default: "example,large" },
    corpora: { type: "string", default: "tiobe,curated" },
    write: { type: "string" },
    "phases-only": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/profile-native-boundary.mjs [--addon profiling.node] [--engine base=json:old.node] [--repeat 15] [--themes single,multi] [--sizes example,large] [--corpora tiobe,curated] [--phases-only] [--write report.json]",
  );
  process.exit(0);
}
const list = (value) => value.split(",").filter(Boolean);
const repeat = Number(values.repeat);
const median = (samples) => quantile(samples, 0.5);
const require = createRequire(import.meta.url);
const gc = (v8.setFlagsFromString("--expose-gc"), runInNewContext("gc"));

function buildProfilingAddon() {
  const target = join(repoRoot, "target", "profiling");
  mkdirSync(join(target, "napi-types"), { recursive: true });
  const build = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--features",
      "profiling",
      "--manifest-path",
      join(repoRoot, "crates/ferriki-core/Cargo.toml"),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: target,
        NAPI_TYPE_DEF_TMP_FOLDER: join(target, "napi-types"),
      },
      stdio: "inherit",
    },
  );
  assert.equal(build.status, 0, "Profiling build failed");
  const library = {
    darwin: "libferriki_core.dylib",
    linux: "libferriki_core.so",
    win32: "ferriki_core.dll",
  }[process.platform];
  const addon = join(target, "ferriki-profiling.node");
  copyFileSync(join(target, "release", library), addon);
  return addon;
}

function open(native, json = false) {
  const encode = (value) => (json ? JSON.stringify(value) : value);
  const highlighter = native.createHighlighter(
    encode({
      standardAssetRoot: fileURLToPath(new URL("../ferriki/assets/shiki", import.meta.url)),
      assets: { remote: false, cacheDir: TEST_ASSET_CACHE_DIR },
    }),
  );
  highlighter.loadStandardTheme("github-dark");
  highlighter.loadStandardTheme("github-light");
  return { highlighter, encode, decode: (value) => (json ? JSON.parse(value) : value) };
}

/** JS heap growth across one call after a full GC, with the result alive. */
function heapBytes(run) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    gc();
    const before = v8.getHeapStatistics().used_heap_size;
    const result = run();
    const bytes = v8.getHeapStatistics().used_heap_size - before;
    samples.push(bytes);
    assert.ok(result);
  }
  return median(samples);
}

function timed(run) {
  for (let i = 0; i < 3; i++) run();
  const samples = [];
  for (let i = 0; i < repeat; i++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

const profiling = open(require(values.addon ?? buildProfilingAddon()));
assert.equal(
  typeof profiling.highlighter.profileTokenBoundary,
  "function",
  "The addon was not built with --features profiling",
);
const engines = values.engine.map((spec) => {
  const [name, ...rest] = spec.split("=");
  const target = rest.join("=");
  const json = target.startsWith("json:");
  return { name, ...open(require(json ? target.slice(5) : target), json) };
});
// The addon that `build:native` produced, resolved exactly like the facade.
const production = { name: "production", ...open(loadFerrikiNativeBinding()) };
const facade = await createHighlighter({ themes: ["github-dark", "github-light"], langs: [] });
const lineTransformer = {
  name: "profile-lines",
  line(node) {
    node.properties["data-line"] = "";
  },
};

const cases = [];
try {
  for (const corpus of list(values.corpora)) {
    for (const language of loadCorpus(corpus).languages.filter((entry) => entry.file)) {
      for (const { highlighter } of [profiling, production, ...engines])
        highlighter.loadStandardGrammar(language.textmate);
      await facade.loadLanguage(language.textmate);
      for (const entry of loadCases(language, list(values.sizes), corpus)) {
        for (const themes of list(values.themes)) {
          const multi = themes === "multi";
          const options = {
            lang: language.textmate,
            theme: "github-dark",
            tokenizeTimeLimit: 500,
            ...(multi
              ? {
                  themeEntries: [
                    { color: "dark", name: "github-dark" },
                    { color: "light", name: "github-light" },
                  ],
                }
              : {}),
          };
          const call = ({ highlighter, encode, decode }) => {
            const encoded = encode(options);
            return multi
              ? () => decode(highlighter.getHtmlRenderDataWithThemes(entry.code, encoded))
              : () => decode(highlighter.getHtmlRenderData(entry.code, encoded));
          };
          for (let i = 0; i < 3; i++)
            profiling.highlighter.profileTokenBoundary(entry.code, options);
          const phases = [];
          for (let i = 0; i < repeat; i++)
            phases.push(profiling.highlighter.profileTokenBoundary(entry.code, options));
          const phase = (name) => ({
            ms: median(phases.map((profile) => profile[name].ms)),
            allocations: median(phases.map((profile) => profile[name].allocations)),
            bytes: median(phases.map((profile) => profile[name].bytes)),
          });
          const facadeOptions = multi
            ? { lang: language.textmate, themes: { dark: "github-dark", light: "github-light" } }
            : { lang: language.textmate, theme: "github-dark" };
          const html = (extra) => () =>
            facade.codeToHtml(entry.code, { ...facadeOptions, ...extra });
          cases.push({
            id: `${corpus}/${language.textmate}/${entry.size}/${themes}`,
            lines: phases[0].lines,
            tokens: phases[0].tokens,
            tokenize: phase("tokenize"),
            dto: phase("dto"),
            convert: phase("convert"),
            ...(values["phases-only"]
              ? {}
              : {
                  nativeCallMs: timed(call(production)),
                  jsHeapBytes: Object.fromEntries(
                    [production, ...engines].map((engine) => [
                      engine.name,
                      heapBytes(call(engine)),
                    ]),
                  ),
                  facadeHtmlMs: {
                    ...(multi ? {} : { native: timed(html({})) }),
                    classes: timed(html({ styleMode: "classes" })),
                    transformer: timed(html({ transformers: [lineTransformer] })),
                  },
                }),
          });
          console.error(`[profile] ${cases.at(-1).id}`);
        }
      }
    }
  }
} finally {
  for (const { highlighter } of [profiling, production, ...engines]) highlighter.dispose();
  facade.dispose();
}

const groups = new Map();
for (const entry of cases) {
  const group = entry.id
    .split("/")
    .filter((_, i) => i !== 1)
    .join("/");
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(entry);
}
const sum = (entries, read) => entries.reduce((total, entry) => total + (read(entry) ?? 0), 0);
const summary = Object.fromEntries(
  [...groups].map(([group, entries]) => [
    group,
    {
      cases: entries.length,
      tokens: sum(entries, (e) => e.tokens),
      tokenizeMs: sum(entries, (e) => e.tokenize.ms),
      dtoMs: sum(entries, (e) => e.dto.ms),
      convertMs: sum(entries, (e) => e.convert.ms),
      nativeCallMs: sum(entries, (e) => e.nativeCallMs),
      tokenizeAllocations: sum(entries, (e) => e.tokenize.allocations),
      dtoAllocations: sum(entries, (e) => e.dto.allocations),
      convertAllocations: sum(entries, (e) => e.convert.allocations),
      jsHeapBytes: Object.fromEntries(
        Object.keys(entries[0].jsHeapBytes ?? {}).map((name) => [
          name,
          sum(entries, (e) => e.jsHeapBytes[name]),
        ]),
      ),
      facadeHtmlMs: Object.fromEntries(
        Object.keys(entries[0].facadeHtmlMs ?? {}).map((name) => [
          name,
          sum(entries, (e) => e.facadeHtmlMs[name]),
        ]),
      ),
    },
  ]),
);
const report = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  options: values,
  summary,
  cases,
};
if (values.write) writeFileSync(values.write, `${JSON.stringify(report)}\n`);
const ms = (value) => value.toFixed(2).padStart(9);
console.log(
  "group                     tokens   tokenize        dto    convert  native call | facade html: native / classes / transformer (ms)",
);
for (const [group, entry] of Object.entries(summary))
  console.log(
    `${group.padEnd(24)} ${String(entry.tokens).padStart(7)} ${ms(entry.tokenizeMs)} ${ms(entry.dtoMs)} ${ms(entry.convertMs)} ${ms(entry.nativeCallMs)}   | ${Object.values(entry.facadeHtmlMs).map(ms).join(" /")}`,
  );
console.log(
  "\ngroup                    Rust allocations: tokenize / dto / convert | JS heap bytes per call",
);
for (const [group, entry] of Object.entries(summary))
  console.log(
    `${group.padEnd(24)} ${entry.tokenizeAllocations} / ${entry.dtoAllocations} / ${entry.convertAllocations} | ${Object.entries(
      entry.jsHeapBytes,
    )
      .map(([name, bytes]) => `${name} ${bytes}`)
      .join(", ")}`,
  );
