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

import { ClosingSection, CodeSection, CoverageSection } from "../components/home-sections";
import {
  agreeingDocuments,
  coldSpeedup,
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
      lede="It uses the TextMate grammars and themes VS Code uses, behind the familiar Shiki API."
      facts={[
        { label: "Succeeds", value: "Shiki" },
        { label: "Checked against", value: "Pinned Shiki release" },
        { label: "Release", value: `v${version}` },
      ]}
      actions={
        <>
          <Link to="/guide/getting-started" className="fam-btn fam-btn-primary">
            Get started <Mark name="arrow" className="icon" size={18} />
          </Link>
          <Link to="/guide/migrating-from-shiki" className="fam-btn fam-btn-ghost">
            Migrate from Shiki
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
    text: "TextMate grammars started in TextMate and power the highlighting in VS Code and Shiki; the language communities maintain them. Ferriki ships catalog metadata for 260 grammars and 65 editor themes. In Node, requested compact payloads download from the release-pinned asset service on first use and are cached locally.",
  },
  {
    heading: "Context, not keyword lists",
    text: "A TextMate grammar follows a language's structure across lines: CSS and JavaScript inside HTML, code fences in Markdown, template literals, heredocs. Ferriki's tokenizer is a mechanical port of vscode-textmate, checked against its own tests.",
  },
  {
    heading: "The API you know",
    text: "codeToHtml, codeToHast, codeToTokens, reusable highlighters and the singleton keep Shiki's shape. Checked against a pinned Shiki release, not just claimed.",
  },
  {
    heading: "No WASM, no regex translation",
    text: "Matching runs in Ferroni, Oniguruma continued in Rust: the regex dialect the grammars were written for, compiled into the addon. No WebAssembly module to initialize, no patterns to translate.",
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
        outputCaption={`Ferriki ${sample.version} · ${sample.theme}`}
      />
    </Section>
  );
}

function EvidenceIntro() {
  return (
    <>
      The same {documents} documents, languages and theme. Strict HTML, HAST and token checks
      qualify the Node full-corpus totals; Ferriki passed those checks on {agreeingDocuments} of{" "}
      {documents}. Each factor is Shiki&rsquo;s time divided by Ferriki&rsquo;s; higher is faster.
    </>
  );
}

function EvidenceNote() {
  return (
    <>
      Measured on {report.measured} at commit <code>{report.revision}</code> on {machine}, against
      Shiki {report.versions.shiki}. The{" "}
      {phikiAvailable
        ? `optional Phiki HTML comparison matched on ${phikiMatchingDocuments} of ${
            report.agreement.phiki?.of ?? documents
          } documents; its shared cohort is separate from these Node totals.`
        : report.phiki?.status === "skipped"
          ? `optional Phiki HTML comparison was skipped: ${report.phiki.reason ?? "PHP and Composer prerequisites unavailable"}.`
          : "Phiki is not recorded in this benchmark report."}{" "}
      The <Link to="/evidence/benchmarks">benchmark page</Link> has every document, every API and
      the command to reproduce it.
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
      <EvidenceFigures
        figures={[
          {
            label: "HTML vs Shiki with WASM",
            value: formatFactor(speedup("codeToHtml", "shiki-wasm")),
            detail: "codeToHtml on a reused highlighter",
            measure: "Oniguruma compiled to WebAssembly",
          },
          {
            label: "HTML vs Shiki with the JS engine",
            value: formatFactor(speedup("codeToHtml", "shiki-js")),
            detail: "codeToHtml on a reused highlighter",
            measure: "Oniguruma patterns translated to JavaScript",
          },
          {
            label: "Cold start vs Shiki with WASM",
            value: formatFactor(coldSpeedup("shiki-wasm")),
            detail: "import, create a highlighter, render every document once",
            measure: `median of ${report.cold.ferriki.runs} fresh processes`,
          },
        ]}
      />
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
        <EvidenceSection />
        <CodeSection />
        <PipelineSection />
        <CoverageSection />
        <ClosingSection />
      </div>
    </RegistryFacts>
  );
}
