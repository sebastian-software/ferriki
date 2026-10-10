import { type ComparisonRow, ComparisonTable } from "ferramenta-family";

import { blacksmith, engineLabels, formatFactor, formatMs, nodeEngines } from "../data/benchmarks";

type Timings = Record<(typeof nodeEngines)[number], number>;
const warmValues = (timings: Timings) =>
  Object.fromEntries(nodeEngines.map((id) => [id, formatMs(timings[id])]));
const changes = (on: Timings, off: Timings) =>
  Object.fromEntries(nodeEngines.map((id) => [id, change(on[id], off[id])]));

const contenders = nodeEngines.map((id) => ({
  id,
  label: engineLabels[id],
  own: id === "ferriki",
}));
const change = (on: number, off: number) => `${(100 * (off / on - 1)).toFixed(1)}%`;

export function BlacksmithSummary() {
  const rows: ComparisonRow[] = blacksmith.profiles.map((profile) => ({
    label: `${profile.label} · ${profile.machine.cpu}`,
    values: warmValues(profile.warm.on),
    verdict: `${formatFactor(profile.warm.on["shiki-wasm"] / profile.warm.on.ferriki)} · ${formatFactor(profile.warm.on["shiki-js"] / profile.warm.on.ferriki)}`,
  }));
  return (
    <ComparisonTable
      caption="Reused highlighters: sum of medians for the same 14 files. Milliseconds; lower is faster. Default prefilter enabled."
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
      label: `${profile.label} · ${entry.language} · ${entry.size}`,
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
      label: `${profile.label} · ${entry.language} · ${entry.size}`,
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
