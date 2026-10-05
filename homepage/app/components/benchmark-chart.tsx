import { useId, useState } from "react";

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
        <strong>Time to render highlighted HTML</strong>
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
      </p>
    </figure>
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
    <div className="ferriki-chart-control">
      <label htmlFor={id}>Compare</label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">Entire corpus · Node engines</option>
        {report.warm.codeToHtml.map((row) => (
          <option value={row.path} key={row.path}>
            {row.lang} · {row.path}
          </option>
        ))}
      </select>
    </div>
  );
}

function ChartBars({
  engines,
  times,
}: {
  engines: EngineId[];
  times: Partial<Record<EngineId, number>>;
}) {
  const maximum = Math.max(...engines.map((engine) => times[engine] ?? 0));
  return (
    <dl>
      {engines.map((engine) => (
        <div className="ferriki-chart-row" data-own={engine === "ferriki"} key={engine}>
          <dt>{engineLabels[engine]}</dt>
          <dd>
            <span className="ferriki-chart-track" aria-hidden="true">
              <span style={{ width: `${((times[engine] ?? 0) / maximum) * 100}%` }} />
            </span>
            <span className="ferriki-chart-value">
              {times[engine] === undefined ? "Not measured" : formatMs(times[engine])}
            </span>
          </dd>
        </div>
      ))}
    </dl>
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
