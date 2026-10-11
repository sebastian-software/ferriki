import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const profileRoot = join(
  repoRoot,
  "node/benchmarks/curated/results/prism-investigation/profiles/current",
);
const index = JSON.parse(readFileSync(join(profileRoot, "index.json"), "utf8"));
const analysisPath = join(profileRoot, "analysis.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceLabel(url) {
  if (url.includes("prismjs@")) return "Prism";
  if (url.includes("/node/ferriki/src/")) return "Ferriki facade";
  if (url.startsWith("node:")) return "Node";
  if (!url) return "native or generated";
  return "harness or other";
}

function summarizeJs(capture) {
  const artifact = capture.artifacts.find((item) => item.path.endsWith("/cpu-profile.json"));
  if (!artifact) return null;
  const profilePath = join(profileRoot, artifact.path);
  const bytes = readFileSync(profilePath);
  const profile = JSON.parse(bytes.toString("utf8"));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const weights = new Map();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const nodeId = profile.samples[index];
    weights.set(nodeId, (weights.get(nodeId) ?? 0) + (profile.timeDeltas[index] ?? 0));
  }
  const totalMicroseconds = profile.timeDeltas.reduce((sum, delta) => sum + delta, 0);
  const frames = new Map();
  for (const [nodeId, microseconds] of weights) {
    const frame = nodes.get(nodeId)?.callFrame;
    if (!frame) continue;
    const name = frame.functionName || "(anonymous)";
    const source = sourceLabel(frame.url || "");
    const key = `${name} @ ${source}`;
    frames.set(key, (frames.get(key) ?? 0) + microseconds);
  }
  const selfFrames = [...frames.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([key, microseconds]) => {
      const [functionName, source] = key.split(" @ ");
      return {
        functionName,
        source,
        sampledMs: Number((microseconds / 1000).toFixed(3)),
        percentOfSampledTime: Number(((100 * microseconds) / totalMicroseconds).toFixed(1)),
      };
    });
  return {
    id: capture.id,
    engine: capture.engine,
    language: capture.language,
    sampleCount: profile.samples.length,
    sampledMs: Number((totalMicroseconds / 1000).toFixed(3)),
    profileSha256: sha256(bytes),
    selfFrames,
  };
}

function parseMainThreadTree(text) {
  let inCallGraph = false;
  let mainThread = null;
  const stack = [];
  for (const line of text.split("\n")) {
    if (line === "Call graph:") {
      inCallGraph = true;
      continue;
    }
    if (!inCallGraph) continue;
    if (line === "Binary Images:") break;
    if (!line.trim()) continue;

    if (line.startsWith("    ") && !line.startsWith("     ")) {
      const content = line.slice(4);
      const separator = content.search(/\s/);
      const sampleCount = separator > 0 ? content.slice(0, separator) : "";
      const label = separator > 0 ? content.slice(separator).trim() : "";
      if (/^\d+$/.test(sampleCount) && label.startsWith("Thread_")) {
        const node = { column: 4, samples: Number(sampleCount), label, children: [] };
        stack.length = 0;
        stack.push(node);
        if (node.label.includes("com.apple.main-thread")) mainThread = node;
        continue;
      }
    }

    let column = 0;
    while (column < line.length && " +!|:".includes(line[column])) column += 1;
    if (column === 0) continue;
    const countMatch = /^\d+/.exec(line.slice(column));
    if (!countMatch) continue;
    const label = line.slice(column + countMatch[0].length).trim();
    const node = { column, samples: Number(countMatch[0]), label, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].column >= node.column) stack.pop();
    if (stack.length === 0) continue;
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  if (!mainThread) throw new Error("The macOS sample report has no main-thread call graph.");
  return mainThread;
}

function inclusiveUnion(node, expression) {
  if (expression.test(node.label)) return node.samples;
  return node.children.reduce((sum, child) => sum + inclusiveUnion(child, expression), 0);
}

const nativeFamilies = {
  textmateTokenization: /Grammar14tokenize_line2|Grammar8tokenize|tokenize_string15tokenize_string/,
  regexScanning:
    /RuleScanner.*find_next_match|find_next_match_utf16|find_next_match_inner|onig_regset_search_impl|regset_search_body|attempt_(?:entries_at|entry_at|fallback_entry|merged_at)|match_at_impl|dfa_prefilter|candidates_at|regex_automata/,
  capturesAndScopes: /handle_captures|produce_from_scopes|LineFonts|line_output/,
  themeMatching: /Theme11match_scope|ScopeAttributesProvider11theme_match/,
  tokenPreparation: /ferriki6render(?:11prepare_tokens|11token_style)/,
  htmlRendering: /ferriki6render11render_html/,
  allocatorFrames: /RawVecInner.*finish_grow|_malloc_zone_|_xzm_|_realloc/,
};

function summarizeNative(capture) {
  const artifact = capture.artifacts.find((item) => item.path.endsWith("/native.sample.txt"));
  if (!artifact) return null;
  const bytes = readFileSync(join(profileRoot, artifact.path));
  const mainThread = parseMainThreadTree(bytes.toString("utf8"));
  const denominator = mainThread.samples;
  const families = Object.fromEntries(
    Object.entries(nativeFamilies).map(([name, expression]) => {
      const samples = inclusiveUnion(mainThread, expression);
      if (samples > denominator)
        throw new Error(`${capture.id}: ${name} exceeds its main-thread denominator.`);
      return [
        name,
        {
          samples,
          percentOfMainThread: Number(((100 * samples) / denominator).toFixed(1)),
        },
      ];
    }),
  );
  return {
    id: capture.id,
    language: capture.language,
    mainThreadSamples: denominator,
    profileSha256: sha256(bytes),
    familyWeights: families,
  };
}

const jsProfiles = index.captures
  .filter((capture) => capture.kind === "js")
  .map(summarizeJs)
  .filter(Boolean);
const nativeProfiles = index.captures
  .filter((capture) => capture.kind === "native")
  .map(summarizeNative)
  .filter(Boolean);
const analysis = {
  schema: 1,
  summaryScriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  method: {
    javascript:
      "Node Inspector timeDeltas are summed at the sampled node and grouped by function name/source class. Percentages are exclusive sampled self time; inclusive JavaScript ancestors are not added.",
    native:
      "Parse the macOS sample call graph as a tree, isolate the com.apple.main-thread root, and compute each family as the union of matching subtrees. Every branch is counted once within a family; weights overlap across families and are not additive.",
    limits:
      "Sampling weights are not latency benchmarks or allocation counts/bytes. Optimized/inlined frames, native callback attribution, allocator sampling, and symbolization limit interpretation.",
  },
  javascript: jsProfiles,
  native: nativeProfiles,
};
writeFileSync(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`);
console.log(
  `Wrote ${jsProfiles.length} JavaScript and ${nativeProfiles.length} native profile summaries to ${analysisPath}.`,
);
