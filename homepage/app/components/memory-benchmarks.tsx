import { type ComparisonRow, ComparisonTable } from "ferramenta-family";

import memoryReport from "../../../docs/benchmarks/blacksmith-memory.json";
import { engineLabels, nodeEngines } from "../data/benchmarks";

type Distribution = { min: number; median: number; max: number };
type MemoryMetric = "finalRss" | "initializedRss" | "peakRss";
const formatMemory = (value: Distribution) =>
  `${(value.median / 2 ** 20).toFixed(1)} [${(value.min / 2 ** 20).toFixed(1)}–${(value.max / 2 ** 20).toFixed(1)}]`;

const descriptions: Record<MemoryMetric, string> = {
  initializedRss: "RSS after initialization and explicit V8 GC, before rendering.",
  finalRss: "RSS after repeated rendering and explicit V8 GC, with the highlighter still loaded.",
  peakRss:
    "Process-lifetime peak RSS through the final render checkpoint, including startup and setup.",
};

export function MemoryBenchmarks({
  metric = "finalRss",
  repositoryOnly = false,
}: {
  metric?: MemoryMetric;
  repositoryOnly?: boolean;
}) {
  const rows: ComparisonRow[] = [];
  for (const profile of memoryReport.profiles) {
    for (const scenario of profile.scenarios) {
      if (repositoryOnly && scenario.id !== "repository") continue;
      rows.push({
        label: `${profile.label} · ${scenario.id === "repository" ? "12 files × 50 passes" : "large TypeScript × 10"}`,
        values: Object.fromEntries(
          nodeEngines.map((engine) => [engine, formatMemory(scenario.engines[engine][metric])]),
        ),
      });
    }
  }
  return (
    <ComparisonTable
      caption={`${descriptions[metric]} MiB, median [min–max] over six fresh processes per engine and workload. Absolute whole-process values; lower uses less resident memory. Scroll horizontally on small screens to compare engines.`}
      subject="Host / workload"
      contenders={nodeEngines.map((id) => ({ id, label: engineLabels[id], own: id === "ferriki" }))}
      rows={rows}
      align="end"
    />
  );
}
