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

/** Corpus totals per API: the headline numbers, including the slower ones. */
export function BenchmarkSummary() {
  return (
    <div className="ferriki-table">
      <table>
        <thead>
          <tr>
            <th scope="col">API</th>
            {engines.map((id) => (
              <th key={id} scope="col">
                {engineLabels[id]}
              </th>
            ))}
            <th scope="col">vs WASM</th>
            <th scope="col">vs JS</th>
          </tr>
        </thead>
        <tbody>
          {apis.map((api) => {
            const totals = report.warmTotalMs[api] as Partial<Record<EngineId, number>>;
            return (
              <tr key={api}>
                <td>
                  <code>{api}</code>
                </td>
                {engines.map((id) => (
                  <td key={id}>{totals[id] === undefined ? "–" : formatMs(totals[id])}</td>
                ))}
                <Factor value={speedup(api, "shiki-wasm")} />
                <Factor value={speedup(api, "shiki-js")} />
              </tr>
            );
          })}
          <tr>
            <td>Cold start</td>
            {engines.map((id) => (
              <td key={id}>{formatMs(report.cold[id].medianMs)}</td>
            ))}
            <Factor value={coldSpeedup("shiki-wasm")} />
            <Factor value={coldSpeedup("shiki-js")} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Factor({ value }: { value: number }) {
  return <td className={value < 1 ? "ferriki-slower" : undefined}>{formatFactor(value)}</td>;
}

/** Every document for one API, with its size and each engine's median. */
export function BenchmarkDocuments({ api }: { api: Api }) {
  return (
    <div className="ferriki-table">
      <table>
        <thead>
          <tr>
            <th scope="col">Document</th>
            <th scope="col">Lines</th>
            {engines.map((id) => (
              <th key={id} scope="col">
                {engineLabels[id]}
              </th>
            ))}
            <th scope="col">vs WASM</th>
          </tr>
        </thead>
        <tbody>
          {report.warm[api].map((row) => {
            const times = row.medianMs as Partial<Record<EngineId, number>>;
            const ferriki = times.ferriki;
            const wasm = times["shiki-wasm"];
            return (
              <tr key={row.path}>
                <td>
                  <a
                    href={`https://github.com/sebastian-software/ferriki/blob/${report.revision}/${row.path}`}
                  >
                    {row.lang}
                  </a>
                </td>
                <td>{row.lines}</td>
                {engines.map((id) => (
                  <td key={id}>{times[id] === undefined ? "–" : formatMs(times[id])}</td>
                ))}
                {ferriki === undefined || wasm === undefined ? (
                  <td>–</td>
                ) : (
                  <Factor value={wasm / ferriki} />
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Where and with what the report was measured. */
export function BenchmarkContext() {
  return (
    <div className="ferriki-table">
      <table>
        <tbody>
          <tr>
            <th scope="row">Measured</th>
            <td>
              {report.measured}, commit <code>{report.revision}</code>
            </td>
          </tr>
          <tr>
            <th scope="row">Machine</th>
            <td>
              {report.machine.cores} × {report.machine.cpu}, {report.machine.memoryGiB} GiB
            </td>
          </tr>
          <tr>
            <th scope="row">System</th>
            <td>
              {report.machine.os} ({report.machine.platform}), Node {report.machine.node}
            </td>
          </tr>
          <tr>
            <th scope="row">Versions</th>
            <td>
              Ferriki {report.versions.ferriki}, Shiki {report.versions.shiki}
            </td>
          </tr>
          <tr>
            <th scope="row">Theme</th>
            <td>{report.theme}</td>
          </tr>
          <tr>
            <th scope="row">Output agreement</th>
            <td>
              {engines
                .map(
                  (id) =>
                    `${engineLabels[id]}: ${report.agreement[id].documents} of ${report.agreement[id].of}`,
                )
                .join(" · ")}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
