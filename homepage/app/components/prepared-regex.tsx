import { EvidenceFigures, Section } from "ferramenta-family";
import { Link } from "react-router";

const steps = [
  [
    "Prepare once",
    "Ferroni compiles regex programs and optimizes static scanner automata ahead of time.",
  ],
  [
    "Download your grammars",
    "Embedded languages share their prepared packages across hosts. The first load verifies, unpacks, and caches them on disk.",
  ],
  [
    "Restore next time",
    "A fresh process checks the cache and reads only the scanner records your document needs.",
  ],
  ["Start optimized", "Static scanners use Eager optimizations from their first execution."],
];

const figures = [
  {
    label: "Smaller Markdown package",
    value: "93%",
    detail: "1.9 MB prepared download · previously 25.9 MB",
    measure: "Same grammar coverage · October 26, 2026 catalog",
  },
  {
    label: "Lower C++ tokenizer startup",
    value: "53%",
    detail: "68 ms prepared · 144 ms source Eager",
    measure: "Local macOS ARM64 diagnostic · first document included",
  },
];

export function PreparedRegexSection() {
  return (
    <Section
      id="prepared-regex"
      tone="dim"
      title="Compile once. Start optimized."
      intro="Make regex optimization part of the grammar you download. Powered by Ferroni 2.7, Ferriki ships prepared regex programs and scanner automata with its standard grammars. The expensive preparation survives a process restart, so each new build can pick up the work already done."
      note={
        <>
          Enabled by default for standard grammars. Keep the disk cache between builds to reuse
          downloads and unpacked packages. Restoration still takes time; dynamic patterns remain
          local, and unavailable packages fall back to source.{" "}
          <Link to="/evidence/benchmarks#prepared-regex">Read the measurements and limits.</Link>
        </>
      }
    >
      <figure className="ferriki-flow">
        <figcaption>From grammar preparation to your next build</figcaption>
        <ol>
          {steps.map(([label, detail]) => (
            <li key={label}>
              <strong>{label}</strong>
              <span>{detail}</span>
            </li>
          ))}
        </ol>
      </figure>
      <EvidenceFigures figures={figures} />
      <p className="fam-note">
        Language packages share embedded scanners instead of shipping each language inside every
        host. Across the catalog, prepared downloads fall from 274 MB to 35 MB. Optional code-fence
        languages stay optional.{" "}
        <Link to="/evidence/benchmarks#shared-language-packages">See the package sizes.</Link>
      </p>
      <p className="fam-note">
        Prepared execution stayed comparable to ordinary Eager in this seven-grammar diagnostic.
        Startup includes archive restoration and the first document; network, file I/O, and full
        builds are outside the timer. This is separate from the older Shiki comparisons below.
      </p>
    </Section>
  );
}
