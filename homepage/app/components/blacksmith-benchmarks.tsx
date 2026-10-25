import { type ComparisonRow, ComparisonTable } from "ferramenta-family";

import {
  blacksmith,
  engineLabels,
  formatFactor,
  formatMs,
  nodeEngines,
  type Timings,
} from "../data/benchmarks";

const warmValues = (timings: Timings) =>
  Object.fromEntries(
    nodeEngines.map((id) => [
      id,
      timings[id] === undefined ? "Unsupported" : formatMs(timings[id]),
    ]),
  );
const changes = (on: Timings, off: Timings) =>
  Object.fromEntries(
    nodeEngines.map((id) => [
      id,
      on[id] === undefined || off[id] === undefined ? "Unsupported" : change(on[id], off[id]),
    ]),
  );

const contenders = nodeEngines.map((id) => ({
  id,
  label: engineLabels[id],
  own: id === "ferriki",
}));
const change = (on: number, off: number) => `${(100 * (off / on - 1)).toFixed(1)}%`;

export function BlacksmithSummary({ firstUse = false }: { firstUse?: boolean }) {
  const rows: ComparisonRow[] = blacksmith.profiles.map((profile) => {
    const timings = firstUse ? profile.cold.on : profile.warm.on;
    return {
      label: `${profile.label} · ${profile.machine.cpu}`,
      values: warmValues(timings),
      verdict: `${formatFactor(timings["shiki-wasm"] / timings.ferriki)} · ${timings["shiki-js"] === undefined ? "Unsupported" : formatFactor(timings["shiki-js"] / timings.ferriki)}`,
    };
  });
  return (
    <ComparisonTable
      caption={
        firstUse
          ? "First use: median over ten fresh processes per engine, including imports, setup of 14 languages and a full corpus render. Cached assets; process creation and downloads excluded. Milliseconds; lower is faster. Default prepared packages enabled."
          : "Reused highlighters: sum of medians for the same 14 files. Milliseconds; lower is faster. Default prefilter enabled."
      }
      subject="Host"
      contenders={contenders}
      rows={rows}
      verdictLabel="Speedup (WASM · JS)"
      align="end"
    />
  );
}

export function RegexModeBenchmarks() {
  const rows: ComparisonRow[] = blacksmith.profiles.flatMap((profile) =>
    ["warm", "cold"].map((phase) => {
      const timings = phase === "warm" ? profile.warm : profile.cold;
      return {
        label: `${profile.label} · ${phase === "warm" ? "reused" : "first use"}`,
        values: { on: formatMs(timings.on.ferriki), off: formatMs(timings.off.ferriki) },
        verdict: change(timings.on.ferriki, timings.off.ferriki),
      };
    }),
  );
  return (
    <ComparisonTable
      caption="Ferriki on the 14-file repository corpus. First use includes imports, setup and rendering; process creation and downloads are excluded. Raw on/off observations, milliseconds."
      subject="Host / use"
      contenders={[
        { id: "on", label: "Prefilter on", own: true },
        { id: "off", label: "Prefilter off" },
      ]}
      rows={rows}
      verdictLabel="Off vs. on"
      align="end"
    />
  );
}

export function JsonAstroBenchmarks() {
  const rows: ComparisonRow[] = blacksmith.profiles.flatMap((profile) =>
    profile.jsonAstro.map((entry) => ({
      label: `${profile.label} · ${profile.corpusMachines.curated.cpu} · ${entry.language} · ${entry.size}`,
      values: warmValues(entry.on),
      verdict: formatFactor(entry.on["shiki-wasm"] / entry.on.ferriki),
    })),
  );
  return (
    <ComparisonTable
      caption="Warm HTML medians with the default prefilter. Example fixtures and large inputs (16 copies); milliseconds. Ferriki and both Shiki engines produce identical HTML."
      subject="Host / document"
      contenders={contenders}
      rows={rows}
      verdictLabel="WASM / Ferriki"
      align="end"
    />
  );
}

export function JsonAstroModeDifferences() {
  const rows: ComparisonRow[] = blacksmith.profiles.flatMap((profile) =>
    profile.jsonAstro.map((entry) => ({
      label: `${profile.label} · ${profile.corpusMachines.curated.cpu} · ${entry.language} · ${entry.size}`,
      values: changes(entry.on, entry.off),
      verdict: "raw observation",
    })),
  );
  return (
    <ComparisonTable
      caption="On/off measurement windows: percentage change in each engine's warm median. Only Ferriki's configuration changes; Shiki serves as a control. Negative values mean shorter times."
      subject="Host / document"
      contenders={contenders}
      rows={rows}
      verdictLabel="Interpretation"
      align="end"
    />
  );
}

const languageEngines = [...nodeEngines, "prism"] as const;
const languageContenders = languageEngines.map((id) => ({
  id,
  label: id === "prism" ? "Prism (independent grammars)" : engineLabels[id],
  own: id === "ferriki",
}));

function LanguageCorpus({
  profile,
  corpus,
}: {
  profile: (typeof blacksmith.profiles)[number];
  corpus: string;
}) {
  const rows = profile.workloads
    .filter((row) => row.corpus === corpus)
    .map((row) => ({
      label: `${row.language} · ${row.size}`,
      values: Object.fromEntries(
        languageEngines.map((id) => [
          id,
          row.timings[id] === undefined ? "Unsupported" : formatMs(row.timings[id]),
        ]),
      ),
    }));
  return (
    <details>
      <summary>
        {profile.label} ·{" "}
        {corpus === "curated" ? "Curated: 20 formats" : "TIOBE: 19 supported ranks"}
      </summary>
      <ComparisonTable
        caption={`${profile.corpusMachines[corpus].cpu}. Warm HTML medians, milliseconds; lower is faster. Default prepared standard packages enabled. Exact TextMate HTML agreement is required for supported native/Shiki cases. Prism uses independent grammars and has no TextMate parity claim. Example and large inputs are separate observations.`}
        subject="Language / size"
        contenders={languageContenders}
        rows={rows}
        align="end"
      />
    </details>
  );
}

export function LanguageBenchmarks() {
  return (
    <>
      {blacksmith.profiles.flatMap((profile) =>
        ["curated", "tiobe"].map((corpus) => (
          <LanguageCorpus key={`${profile.id}-${corpus}`} profile={profile} corpus={corpus} />
        )),
      )}
    </>
  );
}
