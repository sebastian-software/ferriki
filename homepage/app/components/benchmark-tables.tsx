import { type ComparisonRow, ComparisonTable, type Contender, Measured } from "ferramenta-family";

import {
  type Api,
  apis,
  coldSpeedup,
  type EngineId,
  engineLabels,
  formatFactor,
  formatMs,
  report,
  speedup,
} from "../data/benchmarks";

const engines: EngineId[] = ["ferriki", "shiki-wasm", "shiki-js"];
const contenders: Contender[] = engines.map((id) => ({
  id,
  label: engineLabels[id],
  own: id === "ferriki",
}));

function measuredValues(times: Partial<Record<EngineId, number>>): Record<string, string> {
  return Object.fromEntries(
    engines.map((id) => [id, times[id] === undefined ? "–" : formatMs(times[id])]),
  );
}

function speedupPair(api: Api): string {
  return `${formatFactor(speedup(api, "shiki-wasm"))} · ${formatFactor(speedup(api, "shiki-js"))}`;
}

/** Corpus totals per API: the headline numbers, including the slower ones. */
export function BenchmarkSummary() {
  const rows: ComparisonRow[] = apis.map((api) => ({
    label: api,
    values: measuredValues(report.warmTotalMs[api] as Partial<Record<EngineId, number>>),
    verdict: speedupPair(api),
    behind: speedup(api, "shiki-wasm") < 1 || speedup(api, "shiki-js") < 1,
  }));

  rows.push({
    label: "Cold start",
    detail: "Import, highlighter creation and corpus rendering in a fresh process.",
    values: measuredValues(Object.fromEntries(engines.map((id) => [id, report.cold[id].medianMs]))),
    verdict: `${formatFactor(coldSpeedup("shiki-wasm"))} · ${formatFactor(coldSpeedup("shiki-js"))}`,
    behind: coldSpeedup("shiki-wasm") < 1 || coldSpeedup("shiki-js") < 1,
  });

  return (
    <ComparisonTable
      caption="Corpus total: summed median time in milliseconds, lower is faster. Speedup is Shiki's time divided by Ferriki's (WASM · JavaScript; higher is faster)."
      subject="API or run"
      contenders={contenders}
      rows={rows}
      verdictLabel="Speedup (WASM · JS)"
      align="end"
    />
  );
}

/** Every document for one API, with its size and each engine's median. */
export function BenchmarkDocuments({ api }: { api: Api }) {
  const rows: ComparisonRow[] = report.warm[api].map((row) => {
    const times = row.medianMs as Partial<Record<EngineId, number>>;
    const ferriki = times.ferriki;
    const wasm = times["shiki-wasm"];

    return {
      label: row.path,
      detail: (
        <>
          {row.lang} · {row.lines} lines ·{" "}
          <a
            href={`https://github.com/sebastian-software/ferriki/blob/${report.revision}/${row.path}`}
          >
            Source file
          </a>
        </>
      ),
      values: measuredValues(times),
      verdict: ferriki === undefined || wasm === undefined ? "–" : formatFactor(wasm / ferriki),
      behind: ferriki !== undefined && wasm !== undefined && wasm / ferriki < 1,
    };
  });

  return (
    <ComparisonTable
      caption="Median time per document in milliseconds; lower is faster."
      subject="Source file"
      contenders={contenders}
      rows={rows}
      verdictLabel="Shiki WASM / Ferriki"
      align="end"
    />
  );
}

/** Where and with what the report was measured. */
export function BenchmarkContext() {
  return (
    <Measured
      on={report.measured}
      machine={`${report.machine.cores} × ${report.machine.cpu}, ${report.machine.memoryGiB} GiB, ${report.machine.os} (${report.machine.platform}), Node ${report.machine.node}`}
      revision={<code>{report.revision}</code>}
      more={[
        {
          label: "Versions",
          value: `Ferriki ${report.versions.ferriki} · Shiki ${report.versions.shiki}`,
        },
        { label: "Theme", value: report.theme },
        {
          label: "Output agreement",
          value: engines
            .map(
              (id) =>
                `${engineLabels[id]}: ${report.agreement[id].documents} of ${report.agreement[id].of}`,
            )
            .join(" · "),
        },
      ]}
    >
      <a href="#method">Method and reproduction command</a>
    </Measured>
  );
}
