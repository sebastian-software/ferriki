// Every figure the site states about speed comes from one committed report,
// written by `node/scripts/bench-shiki-comparison.mjs`. The landing page and
// the benchmark page derive their numbers here, so they cannot drift apart or
// outlive the next measurement; `scripts/verify-build.mjs` checks that the
// prerendered pages carry them.
import report from "../../../docs/benchmarks/shiki-comparison.json";

export { report };

export type EngineId = "ferriki" | "shiki-js" | "shiki-wasm";
export type Api = "codeToHast" | "codeToHtml" | "codeToTokensBase";

export const engineLabels: Record<EngineId, string> = {
  ferriki: "Ferriki (native)",
  "shiki-wasm": "Shiki + Oniguruma WASM",
  "shiki-js": "Shiki + JavaScript engine",
};

export const apis: Api[] = ["codeToHtml", "codeToHast", "codeToTokensBase"];

/** How many times faster Ferriki is than `other`: their time over Ferriki's. */
export function speedup(api: Api, other: EngineId): number {
  const totals = report.warmTotalMs[api] as Partial<Record<EngineId, number>>;
  const ferriki = totals.ferriki;
  const baseline = totals[other];
  if (ferriki === undefined || baseline === undefined) {
    throw new Error(`The benchmark report has no complete ${api} total for ${other}.`);
  }
  return baseline / ferriki;
}

export function coldSpeedup(other: EngineId): number {
  return report.cold[other].medianMs / report.cold.ferriki.medianMs;
}

/** One decimal, as the pages state it: 1.31 becomes "1.3×". */
export function formatFactor(value: number): string {
  return `${value.toFixed(1)}×`;
}

/** Milliseconds with two significant decimals below 10 ms, one above. */
export function formatMs(value: number): string {
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
}

export const documents = report.warm.codeToHtml.length;
export const agreeingDocuments = report.agreement.ferriki.documents;

/** "4 × Intel(R) Xeon(R) Processor @ 2.10GHz, linux-x64, Node v22.22.2" */
export const machine = `${report.machine.cores} × ${report.machine.cpu}, ${report.machine.platform}, Node ${report.machine.node}`;
