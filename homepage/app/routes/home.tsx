import {
  EvidenceFigures,
  Mark,
  Principles,
  ProjectHero,
  RegistryFacts,
  Relations,
  RunSample,
  Section,
} from "ferramenta-family";
import { Link } from "react-router";

import { BenchmarkChart } from "../components/benchmark-chart";
import { BlacksmithSummary } from "../components/blacksmith-benchmarks";
import {
  ClosingSection,
  CodeSection,
  CoverageSection,
  FlowSection,
  MacroSection,
} from "../components/home-sections";
import { agreeingDocuments, blacksmith, documents, formatFactor, report } from "../data/benchmarks";
import sample from "../data/sample.json";
import { version } from "../version";

function HeroSection() {
  return (
    <ProjectHero
      icon="ferriki"
      title="Ferriki"
      what="A native syntax highlighter for Node.js and Rust."
      lede="Shiki's HTML API, grammars and themes on a native Rust engine. Load a highlighter once and reuse it across your CMS or site build. Vite macros prepare code examples before they reach the browser."
      facts={[
        { label: "Succeeds", value: "Shiki" },
        { label: "Grammars", value: "260" },
        { label: "Release", value: `v${version}` },
      ]}
      actions={
        <>
          <Link to="/guide/getting-started" className="fam-btn fam-btn-primary">
            Get started <Mark name="arrow" className="icon" size={18} />
          </Link>
          <Link to="/guide/build-time-macros" className="fam-btn fam-btn-ghost">
            Highlight at build time
          </Link>
        </>
      }
      install={
        <>
          <code translate="no">npm install @ferriki/core</code>
          <span> · </span>
          <code translate="no">cargo add ferriki</code>
        </>
      }
    />
  );
}

const pillars = [
  {
    heading: "The grammars editors trust",
    text: "TextMate grammars started in TextMate and power the highlighting in VS Code and Shiki; the language communities maintain them. Ferriki covers Shiki's catalog of 260 grammars and 65 themes, fetched on first use from the release-pinned asset service, verified and cached.",
  },
  {
    heading: "Context, not keyword lists",
    text: "A TextMate grammar follows a language's structure across lines: CSS and JavaScript inside HTML, code fences in Markdown, template literals, heredocs. Ferriki's tokenizer is a mechanical port of vscode-textmate, checked against its own tests.",
  },
  {
    heading: "One engine for Node and Rust",
    text: "The ferriki crate on crates.io is the engine itself; the Node.js package runs the same code through a native addon. Ferromark, the family's Markdown parser, highlights Markdown and MDX code fences with it natively. Shiki is a JavaScript library and has no Rust API.",
  },
  {
    heading: "Native highlighting, small installs",
    text: "Ferriki runs directly on your server or build machine, with no WebAssembly to initialize. Ferroni, its Rust pattern engine, understands the original TextMate grammars. Only your platform’s addon is installed; languages and themes download as needed and stay cached.",
  },
];

function PipelineSection() {
  return (
    <Section id="pipeline" title="Where Ferriki fits">
      <Relations current="ferriki" />
    </Section>
  );
}

function SampleSection() {
  return (
    <Section
      id="sample"
      title="One file, three languages"
      intro="An HTML page with a stylesheet and a module script: the HTML grammar hands each block to the CSS and JavaScript grammars, and the template literal inside the script keeps its own scopes. This is Ferriki's committed output for the source on the left."
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
      Load the grammars once, then render block after block. On the same {documents} files, Ferriki
      and both Shiki engines produced identical HTML on both Blacksmith hosts. These figures measure
      repeated highlighting with loaded languages and themes.
    </>
  );
}

function EvidenceNote() {
  return (
    <>
      Measured {report.measured} at commit <code>{report.revision}</code>, with Ferroni{" "}
      {blacksmith.profiles[0].ferroni} and Shiki {report.versions.shiki}. Strict HTML checks passed
      on {agreeingDocuments} of {documents} repository files. The{" "}
      <Link to="/evidence/benchmarks">benchmark page</Link> includes both hosts, first-use timings,
      JSON and Astro, raw reports and reproduction commands. Your workload and hardware determine
      your result.
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
      <div>
        <EvidenceFigures
          figures={blacksmith.profiles.map((profile) => ({
            label: `${profile.label} · faster than Shiki/WASM`,
            value: formatFactor(profile.warm.on["shiki-wasm"] / profile.warm.on.ferriki),
            detail: "codeToHtml on a reused highlighter · 14-file corpus",
            measure: profile.machine.cpu,
          }))}
        />
        <BlacksmithSummary />
        <BenchmarkChart />
      </div>
    </Section>
  );
}

export default function HomePage() {
  return (
    <RegistryFacts>
      <div className="fam-page ferriki-home">
        <HeroSection />
        <Section
          id="why"
          title="Highlighting that understands the language."
          intro="Many highlighters describe each language with a short list of patterns of their own. Ferriki uses the grammars your editor uses, so code on the page reads the way it does where you wrote it."
        >
          <Principles items={pillars} />
        </Section>
        <SampleSection />
        <MacroSection />
        <FlowSection />
        <EvidenceSection />
        <CodeSection />
        <PipelineSection />
        <CoverageSection />
        <ClosingSection />
      </div>
    </RegistryFacts>
  );
}
