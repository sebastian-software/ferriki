import { type ComparisonRow, ComparisonTable } from "ferramenta-family";

import timingReport from "../../../docs/benchmarks/decoded-cache-comparison.json";
import report from "../../../docs/benchmarks/regex-modes-comparison.json";
import { formatMs } from "../data/benchmarks";

const nativeAndShiki = report.engines.filter(({ id }) => id !== "prism");
const nativeLabels: Record<string, string> = {
  "ferriki-off": "Source Off",
  ferriki: "Source Auto",
  "ferriki-eager": "Source Eager",
  "ferriki-precompiled": "Prepared",
};
const contenders = report.engines.map((engine) => ({
  ...engine,
  label: nativeLabels[engine.id] ?? engine.label,
  own: engine.id === "ferriki-precompiled",
}));
const values = (timings: Record<string, number | undefined>) =>
  Object.fromEntries(
    report.engines.map(({ id }) => [
      id,
      timings[id] === undefined ? "Unsupported" : formatMs(timings[id]),
    ]),
  );

export function RegexPolicySummary() {
  const rows: ComparisonRow[] = timingReport.profiles.flatMap((profile) =>
    ["warm", "cold"].map((phase) => ({
      label: `${profile.label} · ${phase === "warm" ? "reused" : "first use"}`,
      values: values(phase === "warm" ? profile.warm : profile.cold),
    })),
  );
  return (
    <ComparisonTable
      caption="Regex policies on the same 14-file repository corpus, with persistent decoded caches. Milliseconds; lower is faster. First use includes imports, setup and rendering in a fresh process; unpacked assets already cached, no downloads or process creation. Warm values sum document medians."
      subject="Host / use"
      contenders={contenders.filter(({ id }) => id !== "prism")}
      rows={rows}
      align="end"
    />
  );
}

type Profile = (typeof report.profiles)[number];
type TimingProfile = (typeof timingReport.profiles)[number];
function PolicyLanguageCorpus({
  profile,
  corpus,
}: {
  profile: TimingProfile;
  corpus: "curated" | "tiobe";
}) {
  const rows: ComparisonRow[] = profile.workloads
    .filter((row) => row.corpus === corpus)
    .map((row) => ({ label: `${row.language} · ${row.size}`, values: values(row.timings) }));
  return (
    <details>
      <summary>
        Regex modes · {profile.label} · {corpus === "curated" ? "20 formats" : "TIOBE"}
      </summary>
      <ComparisonTable
        caption={`${profile.corpusMachines[corpus].cpu}. Separate source Off, Auto, Eager and Prepared contenders; warm HTML medians in milliseconds. Same input and exact native/Shiki HTML for supported cases. Prism uses independent grammars. Scroll or focus the table and use arrow keys to compare columns.`}
        subject="Language / size"
        contenders={contenders}
        rows={rows}
        align="end"
      />
    </details>
  );
}
export function RegexPolicyLanguages() {
  return (
    <>
      {timingReport.profiles.flatMap((profile) =>
        (["curated", "tiobe"] as const).map((corpus) => (
          <PolicyLanguageCorpus key={`${profile.id}-${corpus}`} profile={profile} corpus={corpus} />
        )),
      )}
    </>
  );
}

type Distribution = { min: number; median: number; max: number };
type Metric = "finalRss" | "initializedRss" | "peakRss";
const memory = (value: Distribution) =>
  `${(value.median / 2 ** 20).toFixed(1)} [${(value.min / 2 ** 20).toFixed(1)}–${(value.max / 2 ** 20).toFixed(1)}]`;
type Scenario = Profile["memory"]["scenarios"][number];
function memoryScenarioRows(scenario: Scenario): ComparisonRow[] {
  return (["initializedRss", "finalRss", "peakRss"] as Metric[]).map((metric) => ({
    label: `${scenario.id} · ${{ initializedRss: "initialized", finalRss: "after reuse", peakRss: "peak" }[metric]}`,
    values: Object.fromEntries(
      nativeAndShiki.map(({ id }) => [
        id,
        memory((scenario.engines as Record<string, Record<Metric, Distribution>>)[id][metric]),
      ]),
    ),
  }));
}
function PolicyMemory({ profile }: { profile: Profile }) {
  return (
    <details>
      <summary>Regex modes · {profile.label} · process memory</summary>
      <ComparisonTable
        caption={`${profile.memory.cpu}. Whole-process RSS in MiB; median [min–max] over six isolated processes per contender and workload. Peak includes startup through the final render checkpoint. Repository: 12 files × 50 passes; large TypeScript: ten renders.`}
        subject="Workload / phase"
        contenders={contenders.filter(({ id }) => id !== "prism")}
        rows={profile.memory.scenarios.flatMap(memoryScenarioRows)}
        align="end"
      />
    </details>
  );
}
export function RegexPolicyMemory() {
  return (
    <>
      {report.profiles.map((profile) => (
        <PolicyMemory key={profile.id} profile={profile} />
      ))}
    </>
  );
}
