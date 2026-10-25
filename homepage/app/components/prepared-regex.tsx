import { EvidenceFigures, Section } from "ferramenta-family";
import { Link } from "react-router";

const steps = [
  [
    "Prepare once",
    "Ferroni compiles regex programs and optimizes static scanner automata ahead of time.",
  ],
  [
    "Download your grammars",
    "Ferriki fetches the packages you need. The first load verifies, unpacks, and caches them on disk.",
  ],
  [
    "Restore next time",
    "A fresh process reads and verifies the unpacked cache, then restores the prepared automata.",
  ],
  ["Start optimized", "Static scanners use Eager optimizations from their first execution."],
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
      <EvidenceFigures
        figures={[
          {
            label: "Lower C++ tokenizer startup",
            value: "53%",
            detail: "68 ms prepared · 144 ms source Eager",
            measure: "Local macOS ARM64 diagnostic · first document included",
          },
        ]}
      />
      <p className="fam-note">
        Prepared execution stayed comparable to ordinary Eager in this seven-grammar diagnostic.
        Startup includes archive restoration and the first document; network, file I/O, and full
        builds are outside the timer. This is separate from the older Shiki comparisons below.
      </p>
    </Section>
  );
}
