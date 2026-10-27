import { EvidenceFigures, Section } from "ferramenta-family";
import { Link } from "react-router";

import report from "../../../docs/benchmarks/regex-modes-comparison.json";

const steps = [
  [
    "We prepare the scanners",
    "Ferroni 2.8 does the regex optimization before the language package reaches you.",
  ],
  [
    "You load your languages",
    "Grammars and required dependencies download from the CDN and are verified.",
  ],
  ["The cache keeps the work", "Keep downloads and unpacked packages on disk for the next build."],
  [
    "Your next process reuses it",
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
      title="The regex homework is already done."
      intro="Fast regex scanners take work to prepare. Ferriki does that work ahead of time and ships the result with your standard grammars. Keep the cache between builds, and each new process restores the optimized scanners and gets on with your code."
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
        <figcaption>One preparation, many fresh starts</figcaption>
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
        Embedded languages share their own prepared scanners. Markdown&rsquo;s own prepared package
        shrank from 25.9 MB to 1.9 MB; Astro went from 6.5 MB to 0.52 MB, with the same grammar
        coverage. Optional code-fence languages stay optional.{" "}
        <Link to="/evidence/benchmarks#shared-language-packages">See the smaller packages.</Link>
      </p>
      <p className="fam-note">
        Prepared packages are enabled by default for standard grammars. Missing packages fall back
        to source; custom dynamic patterns stay local. Keep the disk cache between builds to reuse
        the download and unpacked packages.
      </p>
    </Section>
  );
}
