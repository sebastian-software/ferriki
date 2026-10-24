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

import {
  ClosingSection,
  CodeSection,
  CoverageSection,
  MacroSection,
} from "../components/home-sections";
import { PreparedRegexSection } from "../components/prepared-regex";
import { agreeingDocuments, blacksmith, documents, formatFactor, report } from "../data/benchmarks";
import { grammarCount } from "../data/grammar-catalog";
import sample from "../data/sample.json";
import { version } from "../version";

function HeroSection() {
  return (
    <ProjectHero
      icon="ferriki"
      title="Ferriki"
      what="Beautiful code. Optimization, delivered."
      lede="Native TextMate highlighting for Node.js and Rust, with regex optimizations prepared before your build starts. Load standard grammars from the CDN, restore their optimized scanners, and get straight to highlighting."
      facts={[
        { label: "Runtime", value: "Native Rust" },
        { label: "Grammars", value: String(grammarCount) },
        { label: "Regex", value: "Prepared ahead" },
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
      intro="An HTML page with a stylesheet and a module script: the HTML grammar hands each block to the CSS and JavaScript grammars, and the template literal inside the script keeps its own scopes. This is Ferriki’s committed output for the source on the left."
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
      On two Blacksmith hosts, Ferriki and Shiki + WASM produced identical HTML for{" "}
      {agreeingDocuments} of {documents} files in the repository corpus. The figures show repeated{" "}
      <code>codeToHtml</code> calls with languages and themes already loaded.
    </>
  );
}

function EvidenceNote() {
  return (
    <>
      Measured {report.measured} at commit <code>{report.revision}</code>, with Ferroni{" "}
      {blacksmith.profiles[0].ferroni} and Shiki {report.versions.shiki}. The{" "}
      <Link to="/evidence/benchmarks">full benchmark report</Link> includes both hosts, first-use,
      JSON and Astro, memory, raw reports, and reproduction commands. Results depend on workload and
      hardware.
    </>
  );
}

function EvidenceSection() {
  return (
    <Section
      id="evidence"
      layout="split"
      title="Same HTML. Faster repeated highlighting."
      intro={<EvidenceIntro />}
      note={<EvidenceNote />}
    >
      <EvidenceFigures
        figures={blacksmith.profiles.map((profile) => ({
          label: profile.label,
          value: formatFactor(profile.warm.on["shiki-wasm"] / profile.warm.on.ferriki),
          detail: "faster than Shiki + WASM · 14-file repository corpus",
          measure: profile.machine.cpu,
        }))}
      />
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
