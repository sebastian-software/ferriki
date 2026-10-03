import { type ComparisonRow, ComparisonTable, type Contender, Measured } from "ferramenta-family";

import {
  type Api,
  apis,
  coldSpeedup,
  type EngineId,
  engineLabels,
  formatFactor,
  formatMs,
  hasArchivedApiMeasurements,
  htmlEngines,
  nodeEngines,
  phikiAvailable,
  phikiMatchingDocuments,
  type PhpRuntime,
  report,
  speedup,
} from "../data/benchmarks";

function contendersFor(engines: EngineId[]): Contender[] {
  return engines.map((id) => ({
    id,
    label: engineLabels[id],
    own: id === "ferriki",
  }));
}

function measuredValues(
  times: Partial<Record<EngineId, number>>,
  engines: EngineId[] = nodeEngines,
): Record<string, string> {
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
    values: measuredValues(
      report.warmTotalMs[api] as Partial<Record<EngineId, number>>,
      nodeEngines,
    ),
    verdict: speedupPair(api),
    behind: speedup(api, "shiki-wasm") < 1 || speedup(api, "shiki-js") < 1,
  }));

  rows.push({
    label: "Cold start",
    detail: "Import, highlighter creation and corpus rendering in a fresh process.",
    values: measuredValues(
      Object.fromEntries(nodeEngines.map((id) => [id, report.cold[id].medianMs])),
      nodeEngines,
    ),
    verdict: `${formatFactor(coldSpeedup("shiki-wasm"))} · ${formatFactor(coldSpeedup("shiki-js"))}`,
    behind: coldSpeedup("shiki-wasm") < 1 || coldSpeedup("shiki-js") < 1,
  });

  return (
    <ComparisonTable
      caption="Corpus total: summed median time in milliseconds, lower is faster. Speedup is Shiki's time divided by Ferriki's (WASM · JavaScript; higher is faster)."
      subject="API or run"
      contenders={contendersFor(nodeEngines)}
      rows={rows}
      verdictLabel="Speedup (WASM · JS)"
      align="end"
    />
  );
}

/** Every document for one API, with its size and each engine's median. */
export function BenchmarkDocuments() {
  const engines = phikiAvailable ? htmlEngines : nodeEngines;
  const phikiRows = new Map(
    (report.outputAgreement?.documents ?? []).map((row) => [row.path, row]),
  );
  const rows = report.warm.codeToHtml.map((row) =>
    documentComparisonRow(row, { engines, phikiRows }),
  );

  return (
    <ComparisonTable
      caption={
        phikiAvailable
          ? "Per-document HTML median time in milliseconds. Phiki results are shown with their output agreement; differing-output samples are descriptive only and excluded from aggregate totals."
          : "Median HTML time per document in milliseconds; lower is faster."
      }
      subject="Source file"
      contenders={contendersFor(engines)}
      rows={rows}
      verdictLabel="Shiki WASM / Ferriki"
      align="end"
    />
  );
}

/** Explain why the committed report may contain measurements for retired Node APIs. */
export function HistoricalApiNote() {
  if (!hasArchivedApiMeasurements) return null;
  return (
    <p>
      This is a pre-removal HTML baseline measured {report.measured} at Ferriki source revision{" "}
      <a href={`https://github.com/sebastian-software/ferriki/commit/${report.source.revision}`}>
        {report.revision}
      </a>
      . This page presents its HTML results only. The HAST and token timings in the committed JSON
      are archival measurements from the former Node API, not current API or performance claims.
    </p>
  );
}

function phikiAgreementDetail(status?: string, reason?: string) {
  if (status === "match") return "Phiki HTML: source and character styles match.";
  if (status === "different")
    return "Phiki HTML differs; this per-document time is excluded from shared totals.";
  if (status === "error")
    return `Phiki could not render this document: ${reason ?? "unknown error"}`;
  return "Phiki output was not measured.";
}

function documentComparisonRow(
  row: (typeof report.warm.codeToHtml)[number],
  options: {
    engines: EngineId[];
    phikiRows: Map<string, { status?: string; reason?: string }>;
  },
): ComparisonRow {
  const { engines, phikiRows } = options;
  const times = row.medianMs;
  const ferriki = times.ferriki;
  const wasm = times["shiki-wasm"];
  const phiki = phikiRows.get(row.path);
  const phikiDetail = phikiAvailable
    ? phikiAgreementDetail(phiki?.status, phiki?.reason)
    : undefined;

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
        {phikiDetail !== undefined && <> · {phikiDetail}</>}
      </>
    ),
    values: measuredValues(times, engines),
    verdict: ferriki === undefined || wasm === undefined ? "–" : formatFactor(wasm / ferriki),
    behind: ferriki !== undefined && wasm !== undefined && wasm / ferriki < 1,
  };
}

/** Equivalent-work totals only for documents where all four HTML outputs agree. */
export function PhikiSharedHtmlBenchmark() {
  if (!phikiAvailable) return <PhikiUnavailableNote />;

  const shared = report.warmMatchingTotalMs;
  if (!shared) {
    return (
      <p>
        No documents passed the four-engine HTML output checks ({phikiMatchingDocuments} of{" "}
        {report.agreement.phiki?.of ?? report.warm.codeToHtml.length} Phiki outputs match
        Shiki&rsquo;s visible source text and character styles). Per-document Phiki timings remain
        visible in the HTML table below; no equivalent-work aggregate is reported.
      </p>
    );
  }

  const rows: ComparisonRow[] = [
    {
      label: "Warm HTML · sum of per-document medians",
      detail: "Only the shared matching documents; mismatched output is excluded.",
      values: measuredValues(shared.medianMs, htmlEngines),
      verdict: `${shared.documents} of ${shared.of} documents`,
      behind: false,
    },
  ];
  if (report.coldMatching?.status === "available" && report.coldMatching.medianMs) {
    rows.push({
      label: "Cold initialization and HTML",
      detail: "Fresh process per run; process startup excluded and setup/render included.",
      values: measuredValues(report.coldMatching.medianMs, htmlEngines),
      verdict: `median of ${report.coldMatching.runs} runs`,
      behind: false,
    });
  }

  return (
    <ComparisonTable
      caption="Four-engine totals on the same documents whose visible text and per-character styles agree. These are separate from the full-corpus Node headline and have no speedup ratio."
      subject="Measurement"
      contenders={contendersFor(htmlEngines)}
      rows={rows}
      verdictLabel="Shared scope"
      align="end"
    />
  );
}

function PhikiUnavailableNote() {
  const text =
    report.phiki?.status === "skipped"
      ? `Phiki was skipped: ${report.phiki.reason ?? "optional prerequisites were unavailable"}`
      : "Phiki was not recorded in this benchmark report.";
  return <p>{text}</p>;
}

/** Where and with what the report was measured. */
export function BenchmarkContext() {
  return (
    <Measured
      on={report.measured}
      machine={`${report.machine.cores} × ${report.machine.cpu}, ${report.machine.memoryGiB} GiB, ${report.machine.os} (${report.machine.platform}), Node ${report.machine.node}`}
      revision={<code>{report.revision}</code>}
      more={benchmarkContextDetails()}
    >
      <a href="#method">Method and reproduction command</a>
    </Measured>
  );
}

function benchmarkContextDetails() {
  const details = [
    versionDetail(),
    { label: "Theme", value: report.theme },
    nodeAgreementDetail(),
    phikiAgreementContextDetail(),
  ];
  if (phikiAvailable) details.push(phpRuntimeDetail());
  return details;
}

function displayValue(value: null | number | string | undefined): string {
  return value === null || value === undefined ? "unknown" : String(value);
}

function firstPresent<T>(first: null | T | undefined, second: null | T | undefined) {
  return first ?? second;
}

function versionDetail() {
  const base = `Ferriki ${report.versions.ferriki} (workspace source) · Shiki ${
    report.versions.shiki
  } · tm-grammars ${displayValue(report.versions.tmGrammars)} · tm-themes ${displayValue(
    report.versions.tmThemes,
  )}`;
  let phiki = "Phiki not recorded";
  if (report.phiki?.status === "skipped") phiki = "Phiki skipped";
  if (phikiAvailable) {
    phiki = `Phiki ${displayValue(report.versions.phiki)} · PHP ${displayValue(
      firstPresent(report.runtime?.phiki?.php, report.versions.php),
    )} · Oniguruma ${displayValue(report.runtime?.phiki?.oniguruma)} · Composer ${displayValue(
      report.versions.composer,
    )} · PSR simple-cache ${displayValue(report.versions.psrSimpleCache)}`;
  }
  return { label: "Versions", value: `${base} · ${phiki}` };
}

function nodeAgreementDetail() {
  return {
    label: "Node HTML agreement",
    value: nodeEngines
      .map(
        (id) =>
          `${engineLabels[id]}: ${report.agreement[id].documents} of ${report.agreement[id].of}`,
      )
      .join(" · "),
  };
}

function phikiAgreementContextDetail() {
  let value = "not recorded in this benchmark report";
  if (report.phiki?.status === "skipped")
    value = report.phiki.reason ?? "optional PHP prerequisites unavailable";
  if (phikiAvailable) value = phikiCoverageMessage();
  return { label: "Phiki HTML output agreement", value };
}

function phikiCoverageMessage() {
  return `${phikiMatchingDocuments} of ${displayValue(
    firstPresent(report.agreement.phiki?.of, report.warm.codeToHtml.length),
  )}; ${displayValue(report.assets?.phiki?.grammarCount)} embedded grammar assets; ${displayValue(
    report.assets?.phiki?.unsupportedInjectionCount,
  )} external injection assets not activated`;
}

function phpRuntimeDetail() {
  const runtime = report.runtime?.phiki;
  return {
    label: "PHP runtime",
    value: `${phpPlatform(runtime)} · SAPI ${displayValue(runtime?.sapi)} · mbstring ${runtimeStatus(
      runtime?.mbstring,
    )} · ${phpOpcache(runtime)}`,
  };
}

function phpPlatform(runtime?: null | PhpRuntime) {
  return `${displayValue(runtime?.os)}-${displayValue(runtime?.architecture)}`;
}

function phpOpcache(runtime?: null | PhpRuntime) {
  return `OPcache CLI ${displayValue(runtime?.opcache?.enabledForCli)} · JIT ${displayValue(
    runtime?.opcache?.jit,
  )} (${displayValue(runtime?.opcache?.jitBufferSize)} buffer)`;
}

function runtimeStatus(enabled?: boolean) {
  return enabled ? "enabled" : "unavailable";
}
