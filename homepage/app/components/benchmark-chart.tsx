import { useId, useState } from "ardo/react";
import { FerraBars, FerraSelect } from "ferramenta-family/ferra";

import {
  type EngineId,
  engineLabels,
  formatMs,
  htmlEngines,
  nodeEngines,
  phikiAvailable,
  report,
} from "../data/benchmarks";

export function BenchmarkChart({ perDocument = false }: { perDocument?: boolean }) {
  const selectId = useId();
  const [documentPath, setDocumentPath] = useState("");
  const document = report.warm.codeToHtml.find((row) => row.path === documentPath);
  const times: Partial<Record<EngineId, number>> = document
    ? document.medianMs
    : report.warmTotalMs.codeToHtml;
  const engines = document && phikiAvailable ? htmlEngines : nodeEngines;

  return (
    <figure className="ferriki-benchmark-chart">
      <figcaption>
        <strong>Linux x86-64 · time to render highlighted HTML</strong>
        <span>
          {document
            ? `${document.lang} · ${document.lines} lines · median time`
            : `${report.warm.codeToHtml.length} documents · sum of per-document medians`}
          {" · lower is faster"}
        </span>
      </figcaption>
      {perDocument && (
        <DocumentSelect id={selectId} value={documentPath} onChange={setDocumentPath} />
      )}
      <ChartBars engines={engines} times={times} />
      <p>
        Reused highlighters · {report.theme} · measured {report.measured}.
        <PhikiChartNote documentPath={documentPath} />
        <JavaScriptLimitNote />
      </p>
    </figure>
  );
}

function JavaScriptLimitNote() {
  if (report.cold["shiki-js"].status !== "unsupported") return null;
  return (
    <> Shiki/JS does not support the current YAML grammar; its full-corpus total is unavailable.</>
  );
}

function phikiOutputStatus(status?: string) {
  if (status === "match") return "matches the visible text and character styles";
  if (status === "different") return "differs from Shiki";
  if (status === "error") return "could not be rendered";
  return "was not measured";
}

function DocumentSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <FerraSelect
      label="Compare"
      id={id}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      options={[
        { value: "", label: "Entire corpus · Node engines" },
        ...report.warm.codeToHtml.map((row) => ({
          value: row.path,
          label: `${row.lang} · ${row.path}`,
        })),
      ]}
    />
  );
}

function ChartBars({
  engines,
  times,
}: {
  engines: EngineId[];
  times: Partial<Record<EngineId, number>>;
}) {
  return (
    <FerraBars
      caption="Median render time · lower is faster"
      items={engines.map((engine) => ({
        id: engine,
        label: engineLabels[engine],
        value: times[engine] ?? 0,
        displayValue: times[engine] === undefined ? "Not measured" : formatMs(times[engine]),
        highlight: engine === "ferriki",
      }))}
    />
  );
}

function PhikiChartNote({ documentPath }: { documentPath: string }) {
  if (!documentPath || !phikiAvailable) return null;
  const agreement = report.outputAgreement?.documents.find((row) => row.path === documentPath);
  return (
    <>
      {" "}
      Phiki output {phikiOutputStatus(agreement?.status)}; its timing is shown for context and
      excluded from the Node corpus totals.
    </>
  );
}
