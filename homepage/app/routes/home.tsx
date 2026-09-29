import {
  EvidenceFigures,
  IronBand,
  Mark,
  PipelineAssembly,
  ProjectHero,
  RegistryFacts,
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
  report,
  speedup,
} from "../data/benchmarks";
import sample from "../data/sample.json";
import { version } from "../version";

function HeroSection() {
  return (
    <ProjectHero
      mark="ferriki"
      title={
        <>
          Code that looks like your editor. <em>Rendered natively.</em>
        </>
      }
      lede={
        <>
          <strong>Ferriki is Shiki-compatible syntax highlighting with a Rust core.</strong> The
          same TextMate grammars and themes VS Code uses, behind the API you already know from
          Shiki, for Node.js and Rust.
        </>
      }
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
          <span className="ferriki-release">{` · v${version}`}</span>
        </>
      }
    />
  );
}

const pillars = [
  {
    heading: "The grammars editors trust",
    text: "TextMate grammars started in TextMate and power the highlighting in VS Code and Shiki; the language communities maintain them. Ferriki ships Shiki's catalog: 260 grammars and 65 editor themes.",
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
    <Section
      id="pipeline"
      title="Where Ferriki sits"
      intro={
        <>
          Ferroni runs the regular expressions of the TextMate grammars, Ferriki turns them into
          highlighted code, and Ferromark renders the whole Markdown document around it. Each tool
          also works on its own.
        </>
      }
    >
      <PipelineAssembly current="ferriki" />
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

function EvidenceSection() {
  return (
    <Section
      id="evidence"
      layout="split"
      title="Measured against Shiki"
      intro={
        <>
          The same {documents} documents, languages and theme, with output checked for equality
          before any timing: Ferriki matched Shiki on {agreeingDocuments} of {documents}. Each
          factor is Shiki&rsquo;s time divided by Ferriki&rsquo;s; higher is faster.
        </>
      }
      note={
        <>
          Measured on {report.measured} at commit <code>{report.revision}</code> on {machine},
          against Shiki {report.versions.shiki}. The HAST and token APIs are not faster yet: the{" "}
          <Link to="/evidence/benchmarks">benchmark page</Link> has every document, every API and
          the command to reproduce it.
        </>
      }
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
        <IronBand
          id="why"
          title="Highlighting that understands the language."
          intro="Many highlighters describe each language with a short list of patterns of their own. Ferriki uses the grammars your editor uses, so code on the page reads the way it does where you wrote it."
          rows={pillars}
        />
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
