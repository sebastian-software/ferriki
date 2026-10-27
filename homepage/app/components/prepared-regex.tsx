import { EvidenceFigures, Section } from "ferramenta-family";
import { Link } from "react-router";

import report from "../../../docs/benchmarks/regex-modes-comparison.json";

const steps = [
  [
    "Compile before delivery",
    "Ferroni 2.8 compiles static regex programs and prepares Eager scanner automata.",
  ],
  [
    "Ship the optimized package",
    "The CDN delivers those programs and automata alongside the grammar you request.",
  ],
  ["Keep the optimization", "Cache verified downloads and unpacked packages across builds."],
  [
    "Restore, then highlight",
    "Restore the requested scanners and start highlighting with their optimizations ready.",
  ],
];

const milliseconds = (value: number) => `${Math.round(value).toLocaleString("en-US")} ms`;
const figures = report.profiles.map((profile) => ({
  label: `${profile.label} · first HTML`,
  value: milliseconds(profile.cold["ferriki-precompiled"]),
  detail: `${milliseconds(profile.cold["ferriki-off"])} Source Off · ${milliseconds(profile.cold["ferriki-eager"])} Source Eager`,
  measure: profile.corpusMachines.comparison.cpu,
}));

export function PreparedRegexSection() {
  return (
    <Section
      id="prepared-regex"
      tone="dim"
      title="We ship the optimization."
      intro="Precompiled CDN packages are ready for production and enabled by default for standard grammars. They carry compiled regex programs and optimized static scanner automata alongside each syntax definition. Matching runs in Ferroni's native, Oniguruma-compatible engine, with no JavaScript RegExp translation. Each fresh process restores the prepared work and gets on with your code."
      note={
        <>
          October 27 Blacksmith capture: first HTML includes imports, setup, and all fourteen files
          in a fresh process. Downloads and unpacking happen before timing; process creation is
          excluded. Prepared starts within 6% of unoptimized Source Off on both hosts, while taking
          about half Source Eager&rsquo;s first-use time.{" "}
          <Link to="/evidence/benchmarks#four-regex-policies">See every mode and measurement.</Link>
        </>
      }
    >
      <figure className="ferriki-flow">
        <figcaption>From syntax definitions to optimized downloads</figcaption>
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
        The preparation adds download weight: Rust needs about 58 kB in total versus 18 kB for its
        grammar alone. TypeScript with required embeddings needs 4.65 MB versus 0.54 MB; Markdown
        needs 1.97 MB versus 61 kB. Decimal payload sizes, excluding themes and HTTP overhead. Keep
        the disk cache to reuse downloads; decoded data also takes disk space.{" "}
        <Link to="/evidence/benchmarks#shared-language-packages">Compare the download sizes.</Link>
      </p>
      <p className="fam-note">
        Missing packages fall back to source. Capture-dependent end and while patterns stay dynamic
        to preserve TextMate behavior. Only requested languages and required dependencies load;
        optional code-fence languages stay optional.
      </p>
      <p className="fam-note">
        Sponsored by <a href="https://sebastian-software.de/">Sebastian Software</a>, which
        currently covers Ferriki&rsquo;s CDN costs.
      </p>
    </Section>
  );
}
