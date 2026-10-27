import {
  EvidenceFigures,
  Mark,
  ProjectHero,
  RegistryFacts,
  Relations,
  RunSample,
  Section,
} from "ferramenta-family";
import { Link } from "react-router";

import preparedReport from "../../../docs/benchmarks/regex-modes-comparison.json";
import {
  ClosingSection,
  CodeSection,
  CoverageSection,
  MacroSection,
} from "../components/home-sections";
import { PreparedRegexSection } from "../components/prepared-regex";
import { formatFactor } from "../data/benchmarks";
import { grammarCount } from "../data/grammar-catalog";
import sample from "../data/sample.json";
import { version } from "../version";

const measurementDate = new Date(preparedReport.measured).toLocaleDateString("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function HeroSection() {
  return (
    <ProjectHero
      icon="ferriki"
      title="Ferriki"
      what="Beautiful code. Head start included."
      lede="Native syntax highlighting for Node.js and Rust. Our language packages carry compiled regex programs and optimized scanner automata, delivered from the CDN alongside the grammar. The optimization is already in the download."
      facts={[
        { label: "Runtime", value: "Native Rust" },
        { label: "Grammars", value: String(grammarCount) },
        { label: "Regex", value: "Precompiled" },
      ]}
      actions={
        <>
          <Link to="/guide/getting-started" className="fam-btn fam-btn-primary">
            Start with Node.js <Mark name="arrow" className="icon" size={18} />
          </Link>
          <Link to="/guide/build-time-macros" className="fam-btn fam-btn-ghost">
            Use Vite 8
          </Link>
          <Link to="/rust/getting-started" className="fam-btn fam-btn-ghost">
            Use Rust
          </Link>
        </>
      }
      install={
        <>
          <code translate="no">npm install @ferriki/core</code>
          <span> · </span>
          <code translate="no">cargo add ferriki --features remote</code>
        </>
      }
    />
  );
}

function SampleSection() {
  return (
    <Section
      id="sample"
      title="One file, three languages"
      intro="HTML, CSS, and JavaScript share a page. Ferriki follows each language into the next, right down to the template literal inside the script. The result on the right comes straight from Ferriki."
      note={
        <a href="https://github.com/sebastian-software/ferriki/tree/main/homepage/scripts">
          Rendered by scripts/render-sample.mjs with codeToHtml
        </a>
      }
    >
      <RunSample
        input={sample.input}
        inputCaption="index.html"
        inputKind="HTML source"
        output={sample.output}
        outputCaption={`Ferriki v${version} · ${sample.theme}`}
      />
    </Section>
  );
}

function EvidenceIntro() {
  return (
    <>
      One loaded highlighter, block after block. On our fourteen-file repository corpus, Ferriki
      produced identical HTML to Shiki/WASM on Linux and macOS. Here is how much faster repeated{" "}
      <code>codeToHtml</code> calls ran with languages and themes already loaded.
    </>
  );
}

function EvidenceNote() {
  return (
    <>
      Measured <time dateTime={preparedReport.measured}>{measurementDate}</time> with Ferriki{" "}
      {preparedReport.ferriki} and Ferroni {preparedReport.ferroni} in this{" "}
      <a href={preparedReport.runUrl}>Blacksmith run</a>. These measure highlighting, not total
      build time. The <Link to="/evidence/benchmarks">full report</Link> has every language case,
      startup, memory, and raw results. Results depend on workload and hardware.
    </>
  );
}

function EvidenceSection() {
  return (
    <Section
      id="evidence"
      layout="split"
      title="The numbers look good, too."
      intro={<EvidenceIntro />}
      note={<EvidenceNote />}
    >
      <EvidenceFigures
        figures={preparedReport.profiles.map((profile) => ({
          label: profile.label,
          value: formatFactor(profile.warm["shiki-wasm"] / profile.warm["ferriki-precompiled"]),
          detail: "faster than Shiki/WASM",
          measure: profile.corpusMachines.comparison.cpu,
        }))}
      />
      <p className="fam-note">
        Prepared also used about 45% less whole-process RSS than Shiki/WASM after 600 documents
        across twelve loaded languages on both hosts. Six isolated processes per contender; all
        produced identical HTML.{" "}
        <Link to="/evidence/benchmarks#process-memory-by-policy">Compare the memory results.</Link>
      </p>
    </Section>
  );
}

function PipelineSection() {
  return (
    <Section id="pipeline" title="Part of your build">
      <Relations current="ferriki" />
    </Section>
  );
}

export default function HomePage() {
  return (
    <RegistryFacts>
      <div className="fam-page ferriki-home">
        <HeroSection />
        <PreparedRegexSection />
        <SampleSection />
        <CodeSection />
        <MacroSection />
        <EvidenceSection />
        <PipelineSection />
        <CoverageSection />
        <ClosingSection />
      </div>
    </RegistryFacts>
  );
}
