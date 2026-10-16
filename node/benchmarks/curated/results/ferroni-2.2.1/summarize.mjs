import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { quantile } from "../../../../scripts/tiobe-benchmark.mjs";

const read = (name) => {
  const bytes = readFileSync(new URL(name, import.meta.url));
  return JSON.parse(name.endsWith(".gz") ? gunzipSync(bytes) : bytes);
};
const median = (values) => quantile(values, 0.5);
const summarizeWarm = (name) => {
  const report = read(name);
  const [baseline, candidate] = report.engines.map((engine) => engine.name);
  return {
    baseline,
    candidate,
    groups: report.summary[candidate],
    cases: report.runs[0].cases.map((entry, index) => {
      const samples = report.runs.map((run) => run.cases[index].samplesMs);
      const changes = samples.map(
        (sample) => median(sample[candidate]) / median(sample[baseline]) - 1,
      );
      return {
        id: entry.id,
        baselineMedianMs: median(samples.flatMap((sample) => sample[baseline])),
        candidateMedianMs: median(samples.flatMap((sample) => sample[candidate])),
        medianChange: median(changes),
        minChange: Math.min(...changes),
        maxChange: Math.max(...changes),
      };
    }),
  };
};
const summarizeCold = (name) => {
  const report = read(name);
  const samples = report.samples;
  return [...new Set(samples.map((sample) => sample.lang))].flatMap((lang) =>
    ["example", "large"].map((size) => ({
      lang,
      size,
      engines: Object.fromEntries(
        [...new Set(samples.map((sample) => sample.engine))].map((engine) => {
          const selected = samples.filter(
            (sample) => sample.lang === lang && sample.size === size && sample.engine === engine,
          );
          return [
            engine,
            Object.fromEntries(
              ["loadMs", "setupMs", "firstHtmlMs", "totalMs"].map((metric) => [
                metric,
                median(selected.map((sample) => sample[metric])),
              ]),
            ),
          ];
        }),
      ),
    })),
  );
};
writeFileSync(
  new URL("summary.json", import.meta.url),
  `${JSON.stringify(
    {
      warm: summarizeWarm("warm.json.gz"),
      followup: summarizeWarm("followup.json.gz"),
      cold: summarizeCold("cold.json"),
      eagerWarm: summarizeWarm("eager-warm.json.gz"),
      eagerCold: summarizeCold("eager-cold.json"),
    },
    null,
    2,
  )}\n`,
);
