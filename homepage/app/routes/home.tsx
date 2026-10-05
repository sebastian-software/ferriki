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
import {
  ClosingSection,
  CodeSection,
  CoverageSection,
  FlowSection,
  MacroSection,
} from "../components/home-sections";
import {
  agreeingDocuments,
  documents,
  formatFactor,
  machine,
  phikiAvailable,
  phikiMatchingDocuments,
  report,
  speedup,
} from "../data/benchmarks";
import sample from "../data/sample.json";
import { version } from "../version";

function HeroSection() {
  return (
    <ProjectHero
      icon="ferriki"
      title="Ferriki"
      what="A native syntax highlighter for Node.js and Rust."
      lede="Shiki's HTML API and the TextMate grammars your editor uses, on a Rust engine. Highlight at build time with Vite macros, or from Rust without Node.js."
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
      The same {documents} documents, languages and theme. Strict HTML checks qualify the Node
      full-corpus totals; Ferriki passed those checks on {agreeingDocuments} of {documents}. Each
      factor is Shiki&rsquo;s time divided by Ferriki&rsquo;s; higher is faster.
    </>
  );
}

function EvidenceNote() {
  return (
    <>
      Measured on {report.measured} at commit <code>{report.revision}</code> on {machine}, against
      Shiki {report.versions.shiki}.{" "}
      {phikiAvailable
        ? `Phiki (PHP) is also measured per document; its HTML matched on ${phikiMatchingDocuments} of ${
            report.agreement.phiki?.of ?? documents
          } documents. Its timings remain visible on the benchmark page, with the output differences noted.`
        : report.phiki?.status === "skipped"
          ? `The optional Phiki HTML comparison was skipped: ${report.phiki.reason ?? "PHP and Composer prerequisites unavailable"}.`
          : "Phiki is not recorded in this benchmark report."}{" "}
      The <Link to="/evidence/benchmarks">benchmark page</Link> has every document, HTML timings and
      the command to reproduce them.
    </>
  );
}

function EvidenceSection() {
  return (
    <Section
      id="evidence"
      layout="split"
      title="Measured against Shiki"
      intro={<EvidenceIntro />}
      note={<EvidenceNote />}
    >
      <div>
        <EvidenceFigures
          figures={[
            {
              label: "Faster than Shiki with WASM",
              value: formatFactor(speedup("codeToHtml", "shiki-wasm")),
              detail: "codeToHtml on a reused highlighter",
              measure: "Oniguruma compiled to WebAssembly",
            },
            {
              label: "Faster than Shiki with the JS engine",
              value: formatFactor(speedup("codeToHtml", "shiki-js")),
              detail: "codeToHtml on a reused highlighter",
              measure: "Oniguruma patterns translated to JavaScript",
            },
          ]}
        />
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
