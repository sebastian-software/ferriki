import { regexModeEngines, regexModeLabels } from "./regex-benchmark-modes.mjs";

export function renderRegexModeSummary(reports, context, errors) {
  const lines = [
    `# Ferriki regex modes: ${context.profile}`,
    "",
    `Commit: ${context.commit}. Node: ${context.node}.`,
    ...(context.corpusContexts
      ? Object.entries(context.corpusContexts).map(
          ([corpus, vm]) => `${corpus}: ${vm.cpu} (${vm.cores} cores).`,
        )
      : [`CPU: ${context.cpu} (${context.cores} cores).`]),
    "",
    "Source Off, Auto (lazy DFA), Eager and prepared Eager are separate contenders. Source contenders do not open prepared archives. All contenders share each corpus VM and rotate within timing rounds. Prepared groups are used only where standard packages exist; custom-only grammars retain source fallback.",
    "",
    "Warm medians reuse highlighters. First use includes imports, setup and one repository corpus render in a fresh process; downloads and process creation are excluded. Diagnostics are captured outside timed calls and confirm policy/archive use, not complete group coverage.",
    "",
    `| Workload | ${regexModeEngines.map((id) => regexModeLabels[id]).join(" | ")} |`,
    `| --- | ${regexModeEngines.map(() => "---:").join(" | ")} |`,
  ];
  const row = (label, values) =>
    lines.push(
      `| ${label} | ${regexModeEngines.map((id) => (Number.isFinite(values[id]) ? values[id].toFixed(3) : "unsupported")).join(" | ")} |`,
    );
  const repository = reports["comparison-modes"];
  if (repository) {
    row("Repository / warm ms", repository.warmTotalMs.codeToHtml);
    row(
      "Repository / first use ms",
      Object.fromEntries(
        Object.entries(repository.cold).map(([id, value]) => [id, value.medianMs]),
      ),
    );
  }
  for (const corpus of ["curated", "tiobe"]) {
    for (const language of reports[`${corpus}-modes`]?.languages ?? []) {
      for (const entry of language.cases ?? [])
        row(
          `${corpus} / ${language.name} / ${entry.size} ms`,
          Object.fromEntries(
            Object.entries(entry.results).map(([id, value]) => [id, value.html?.medianMs]),
          ),
        );
    }
  }
  lines.push(
    "",
    errors.length
      ? "Validation failed; inspect original diagnostics before using these timings."
      : "All required exact native/Shiki HTML checks and regex-mode diagnostics passed. Prism uses independent grammars and has no TextMate parity claim.",
    "",
    ...errors.map((error) => `- ${error}`),
    "",
  );
  return lines.join("\n");
}
