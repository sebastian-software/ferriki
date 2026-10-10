import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const report = JSON.parse(gunzipSync(readFileSync(new URL("./paired.json.gz", import.meta.url))));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
};
const pairs = [
  ["ferroni-2.1.0", "ferroni-2.0.0"],
  ["ferroni-2.1.0", "ferroni-1.8.0"],
  ["prefilter-off", "ferroni-2.1.0"],
];
const summarizeCases = (input, candidate, baseline) =>
  input.runs[0].cases.map((entry, index) => {
    const ratios = input.runs.map((run) => {
      const samples = run.cases[index].samplesMs;
      return median(samples[candidate]) / median(samples[baseline]);
    });
    return {
      id: entry.id,
      medianChange: median(ratios) - 1,
      minChange: Math.min(...ratios) - 1,
      maxChange: Math.max(...ratios) - 1,
      baselineMedianMs: median(input.runs.flatMap((run) => run.cases[index].samplesMs[baseline])),
      candidateMedianMs: median(input.runs.flatMap((run) => run.cases[index].samplesMs[candidate])),
    };
  });
const comparisons = {};
for (const [candidate, baseline] of pairs) {
  const cases = summarizeCases(report, candidate, baseline);
  const groups = {};
  const selectors = {
    all: () => true,
    html: (id) => id.endsWith("/html"),
    single: (id) => id.endsWith("/single"),
    multi: (id) => id.endsWith("/multi"),
  };
  for (const corpus of ["curated", "tiobe"])
    for (const size of ["example", "large"])
      selectors[`${corpus}/${size}/html`] = (id) =>
        id.startsWith(`${corpus}/`) && id.endsWith(`/${size}/html`);
  for (const [group, select] of Object.entries(selectors)) {
    const indices = cases.flatMap((entry, index) => (select(entry.id) ? [index] : []));
    const ratios = report.runs.map((run) =>
      Math.exp(
        indices.reduce((sum, index) => {
          const samples = run.cases[index].samplesMs;
          return sum + Math.log(median(samples[candidate]) / median(samples[baseline]));
        }, 0) / indices.length,
      ),
    );
    groups[group] = {
      cases: indices.length,
      medianChange: median(ratios) - 1,
      minChange: Math.min(...ratios) - 1,
      maxChange: Math.max(...ratios) - 1,
      changePerProcess: ratios.map((ratio) => ratio - 1),
    };
  }
  comparisons[`${candidate} vs ${baseline}`] = { groups, cases };
}
const steady = JSON.parse(gunzipSync(readFileSync(new URL("./steady.json.gz", import.meta.url))));
const steadyState = Object.fromEntries(
  pairs.map(([candidate, baseline]) => [
    `${candidate} vs ${baseline}`,
    summarizeCases(steady, candidate, baseline),
  ]),
);
const cold = JSON.parse(readFileSync(new URL("./cold.json", import.meta.url)));
const firstUse = [];
for (const lang of [...new Set(cold.samples.map((sample) => sample.lang))]) {
  for (const size of ["example", "large"]) {
    const engines = {};
    for (const engine of ["1.8.0", "2.0.0", "2.1.0", "prefilter-off"]) {
      const samples = cold.samples.filter(
        (sample) => sample.lang === lang && sample.size === size && sample.engine === engine,
      );
      engines[engine] = Object.fromEntries(
        ["loadMs", "setupMs", "firstHtmlMs", "totalMs"].map((metric) => [
          metric,
          median(samples.map((sample) => sample[metric])),
        ]),
      );
    }
    firstUse.push({ lang, size, engines });
  }
}
writeFileSync(
  new URL("./summary.json", import.meta.url),
  `${JSON.stringify({ comparisons, steadyState, firstUse }, null, 2)}\n`,
);
