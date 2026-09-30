import process from "node:process";
import { engines, readReport } from "./tiobe-benchmark.mjs";
if (process.argv.length !== 3)
  throw new Error("Usage: node scripts/render-tiobe.mjs report.json[.gz]");
const report = readReport(process.argv[2]);
console.log(`# ${report.corpus.name ?? `TIOBE ${report.corpus.month}`} highlighting benchmark\n`);
console.log(
  `Measured ${report.measuredAt}. ${report.machine.cpu}, ${report.machine.platform}, Node ${report.machine.node}.\n`,
);
console.log(
  `Ferriki ${report.versions.ferriki}; Ferroni ${report.nativeBuild.ferroni.version}; Shiki ${report.versions.shiki}; Prism ${report.versions.prism}.\n`,
);
console.log(
  "Warm medians in milliseconds per document. Smaller values are faster. Prism uses independent grammars and class-based HTML; it does not provide TextMate/color parity. A dagger marks a TextMate output mismatch; errors and timeouts are visible.\n",
);
for (const api of report.method.apis) {
  console.log(`## ${api === "html" ? "HTML rendering" : "Tokenization"}\n`);
  console.log(`| Rank | Language | Size | Bytes | ${engines.join(" | ")} |`);
  console.log(`| --- | --- | --- | --- | ${engines.map(() => "---:").join(" | ")} |`);
  for (const language of report.languages) {
    if (language.status !== "measured") {
      console.log(
        `| ${language.rank} | ${language.name} | ${language.status} | — | ${engines.map(() => "—").join(" | ")} |`,
      );
      continue;
    }
    for (const entry of language.cases) {
      const cells = engines.map((id) => {
        const result = entry.results[id];
        if (result.status !== "ok") return result.status;
        const parity = result.validation.referenceParity;
        return `${result[api].medianMs.toFixed(3)}${parity && (!parity.tokens || !parity.html) ? " †" : ""}`;
      });
      console.log(
        `| ${language.rank} | ${language.name} | ${entry.size} | ${entry.bytes} | ${cells.join(" | ")} |`,
      );
    }
  }
  console.log();
}
for (const language of report.languages.filter((row) => row.status !== "measured"))
  console.log(`- ${language.name}: ${language.unsupported ?? language.error}`);

for (const language of report.languages.filter((row) => row.status === "measured")) {
  for (const id of engines) {
    const problems = [
      ...new Set(
        language.cases
          .map((entry) => entry.results[id])
          .filter((r) => r.status !== "ok")
          .map((r) => r.reason ?? r.error),
      ),
    ];
    if (problems.length) console.log(`- ${language.name}/${id}: ${problems.join("; ")}`);
  }
}
