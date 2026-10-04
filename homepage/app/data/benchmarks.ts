// Every figure the site states about speed comes from one committed report,
// written by `node/scripts/bench-shiki-comparison.mjs`. The landing page and
// the benchmark page derive their numbers here, so they cannot drift apart or
// outlive the next measurement; `scripts/verify-build.mjs` checks that the
// prerendered pages carry them.
import sourceReport from "../../../docs/benchmarks/shiki-comparison.json";

export type EngineId = "ferriki" | "phiki" | "shiki-js" | "shiki-wasm";
export type NodeEngineId = Exclude<EngineId, "phiki">;
export type Api = "codeToHtml";

type BenchmarkRow = {
  lang: string;
  path: string;
  lines: number;
  bytes: number;
  medianMs: Partial<Record<EngineId, number>>;
};

type EngineAgreement = { documents: number; of: number };

type OutputAgreementRow = {
  path: string;
  status: string;
  textAgrees?: boolean;
  stylesAgree?: boolean;
  reason?: string;
  difference?: { kind: string; characterIndex: number; renderer?: string };
};

type ExtendedReport = {
  measured: string;
  revision: string;
  source: {
    revision: string;
    tree: string;
    workingTreeClean: boolean;
  };
  method?: { apis?: string[] };
  machine: {
    cores: number;
    cpu: string;
    memoryGiB: number;
    platform: string;
    os: string;
    node: string;
  };
  versions: {
    ferriki: string;
    shiki: string;
    tmGrammars?: string;
    tmThemes?: string;
    phiki?: null | string;
    psrSimpleCache?: null | string;
    php?: null | string;
    composer?: null | string;
  };
  agreement: {
    ferriki: EngineAgreement;
    "shiki-wasm": EngineAgreement;
    "shiki-js": EngineAgreement;
    phiki?: { status: string; documents: number; of: number };
  };
  outputAgreement?: { criteria: string; documents: OutputAgreementRow[] };
  phiki?: { status: string; reason?: string };
  runtime?: {
    node?: string;
    phpIniArguments?: string[];
    phiki?: {
      php?: string;
      version?: string;
      versionId?: number;
      os?: string;
      architecture?: string;
      sapi?: string;
      mbstring?: boolean;
      oniguruma?: null | string;
      opcacheLoaded?: boolean;
      opcacheEnabled?: string;
      opcacheCli?: string;
      jit?: string;
      jitBufferSize?: string;
      xdebug?: boolean;
      opcache?: { enabledForCli?: string; jit?: string; jitBufferSize?: string };
    } | null;
  };
  assets?: {
    tmGrammars?: string;
    tmThemes?: string;
    phiki?: {
      grammarCount?: number;
      unsupportedInjectionCount?: number;
    } | null;
  };
  warmMatchingTotalMs?: {
    documents: number;
    of: number;
    medianMs: Partial<Record<EngineId, number>>;
  };
  coldMatching?: {
    status: string;
    documents: number;
    of: number;
    medianMs?: Partial<Record<EngineId, number>>;
    runs?: number;
    reason?: string;
  };
  theme: string;
  warm: Record<Api, BenchmarkRow[]>;
  cold: Record<NodeEngineId, { medianMs: number; runs: number }>;
  warmTotalMs: Record<Api, Partial<Record<NodeEngineId, number>>>;
};

export const report: ExtendedReport = sourceReport;
export type PhpRuntime = NonNullable<NonNullable<ExtendedReport["runtime"]>["phiki"]>;

export const engineLabels: Record<EngineId, string> = {
  ferriki: "Ferriki (native)",
  "shiki-wasm": "Shiki + Oniguruma WASM",
  "shiki-js": "Shiki + JavaScript engine",
  phiki: "Phiki (PHP)",
};

export const nodeEngines: NodeEngineId[] = ["ferriki", "shiki-wasm", "shiki-js"];
export const htmlEngines: EngineId[] = [...nodeEngines, "phiki"];

export const apis: Api[] = ["codeToHtml"];

/** How many times faster Ferriki is than `other`: their time over Ferriki's. */
export function speedup(api: Api, other: NodeEngineId): number {
  const totals = report.warmTotalMs[api];
  const ferriki = totals.ferriki;
  const baseline = totals[other];
  if (ferriki === undefined || baseline === undefined) {
    throw new Error(`The benchmark report has no complete ${api} total for ${other}.`);
  }
  return baseline / ferriki;
}

export function coldSpeedup(other: NodeEngineId): number {
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
export const phikiAvailable = report.phiki?.status === "available";
export const phikiMatchingDocuments = report.agreement.phiki?.documents ?? 0;

/** "4 × Intel(R) Xeon(R) Processor @ 2.10GHz, linux-x64, Node v22.22.2" */
export const machine = `${report.machine.cores} × ${report.machine.cpu}, ${report.machine.platform}, Node ${report.machine.node}`;
