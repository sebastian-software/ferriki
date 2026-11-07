/*
 * The homepage's figures, derived from the verified evidence reports in
 * app/data/evidence/ and the specimens in app/data/homepage-samples.json.
 * Nothing here is typed by hand except which alternatives the overview names;
 * a new campaign that breaks a claim the copy makes fails the build instead of
 * quietly changing its meaning.
 */
import modes from "../data/evidence/regex-modes-comparison.json";
import shiki from "../data/evidence/shiki-comparison.json";

export { default as samples } from "../data/homepage-samples.json";

/** Ferriki's contender: prepared language packages, the default. */
const own = "ferriki-precompiled";

/** The best-known alternatives the chart names; the evidence page lists every contender. */
export const featured = [
  { id: "shiki-wasm", label: "Shiki, WASM engine", sub: "Oniguruma in WebAssembly" },
  { id: "shiki-js", label: "Shiki, JavaScript engine", sub: "patterns translated to JavaScript" },
  { id: "prism", label: "Prism", sub: "its own, simpler grammars" },
] as const;
export type FeaturedId = (typeof featured)[number]["id"];

type Workload = (typeof modes.profiles)[number]["workloads"][number];
const timing = (workload: Workload, id: string): number | undefined =>
  (workload.timings as Record<string, number | undefined>)[id];

export const platforms = modes.profiles.map((profile) => ({
  id: profile.id,
  label: profile.label,
  cpu: profile.corpusMachines.curated.cpu,
}));
export const measured = {
  date: modes.measured,
  runUrl: modes.runUrl,
  ferriki: modes.ferriki,
  ferroni: modes.ferroni,
};

const first = modes.profiles[0].workloads;
const corpusLanguages = (name: string) =>
  new Set(first.filter((entry) => entry.corpus === name).map((entry) => entry.language)).size;
/** The language workloads: every format at an example size and a large one. */
export const corpus = {
  files: first.length,
  curated: corpusLanguages("curated"),
  tiobe: corpusLanguages("tiobe"),
  /** Distinct languages: the two sets overlap. */
  languages: new Set(first.map((entry) => entry.language)).size,
};
for (const profile of modes.profiles) {
  if (
    profile.workloads.length !== corpus.files ||
    profile.workloads.some((entry) => timing(entry, own) === undefined) ||
    corpus.files !== 2 * (corpus.curated + corpus.tiobe)
  ) {
    throw new Error("The homepage describes one set of language workloads in two sizes");
  }
}

export type Pair = {
  /** Their summed medians over Ferriki's, over the files both can highlight. */
  ratio: number;
  files: number;
  /** Files on which Ferriki needed less time. */
  ahead: number;
};

/** Time for the same work: an alternative's summed medians over Ferriki's. */
export function pair(platform: string, id: FeaturedId): Pair {
  const profile = modes.profiles.find((entry) => entry.id === platform);
  if (profile === undefined) throw new Error(`Missing benchmark profile ${platform}`);
  const shared = profile.workloads.filter((entry) => timing(entry, id) !== undefined);
  const sum = (contender: string) =>
    shared.reduce((total, entry) => total + (timing(entry, contender) ?? 0), 0);
  return {
    ratio: sum(id) / sum(own),
    files: shared.length,
    ahead: shared.filter((entry) => (timing(entry, own) ?? 0) < (timing(entry, id) ?? 0)).length,
  };
}

// The copy says Ferriki needs less time than both Shiki engines and more than Prism.
for (const platform of platforms) {
  const [wasm, javascript, prism] = featured.map((entry) => pair(platform.id, entry.id).ratio);
  if (wasm <= 1 || javascript <= 1 || prism >= 1) {
    throw new Error(`Update the homepage copy: the ${platform.id} ranking changed`);
  }
}
const wasmRatios = platforms.map((platform) => pair(platform.id, "shiki-wasm").ratio);
/** "5.0–5.9×": how many times as long Shiki's WASM engine needed, across both machines. */
export const shikiRange = `${Math.min(...wasmRatios).toFixed(1)}–${Math.max(...wasmRatios).toFixed(1)}×`;

/* ---------- First use and memory ---------- */

export const firstUse = [
  { id: own, label: "Ferriki, prepared packages (the default)" },
  { id: "ferriki", label: "Ferriki, preparing its scanners at startup" },
  { id: "shiki-wasm", label: "Shiki, WASM engine" },
].map((row) => ({
  ...row,
  values: modes.profiles.map((profile) => {
    const value = (profile.cold as Record<string, number | undefined>)[row.id];
    if (value === undefined) throw new Error(`Missing first-use timing for ${row.id}`);
    return value;
  }),
}));
export const firstUseDocuments = shiki.warm.codeToHtml.length;
// The copy says the prepared packages start sooner than self-prepared scanners, and those sooner than Shiki.
for (const index of modes.profiles.keys()) {
  const [prepared, self, wasm] = firstUse.map((row) => row.values[index]);
  if (prepared >= self || self >= wasm) {
    throw new Error("Update the homepage copy: the first-use ranking changed");
  }
}

const repository = modes.profiles.map((profile) => {
  const scenario = profile.memory.scenarios.find((entry) => entry.id === "repository");
  if (scenario === undefined) throw new Error("Missing the repository memory scenario");
  return scenario;
});
const reductions = repository.map((scenario) =>
  Math.round(
    100 *
      (1 - scenario.engines[own].finalRss.median / scenario.engines["shiki-wasm"].finalRss.median),
  ),
);
/** "45": whole-process memory saved against Shiki's WASM engine; a range when the hosts differ. */
export const memorySaved =
  Math.min(...reductions) === Math.max(...reductions)
    ? `${reductions[0]}`
    : `${Math.min(...reductions)}–${Math.max(...reductions)}`;
export const memoryWorkload = {
  renders: repository[0].documents * repository[0].passes,
  files: repository[0].documents,
};

/* ---------- Agreement with Shiki ---------- */

/** Repository files whose HTML is byte for byte Shiki's (Oniguruma in WebAssembly). */
export const agreement = {
  same: shiki.agreement.ferriki.documents,
  of: shiki.agreement.ferriki.of,
  measured: shiki.measured,
  ferriki: shiki.versions.ferriki,
  shiki: shiki.versions.shiki,
};

export const formatMs = (value: number) => `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
