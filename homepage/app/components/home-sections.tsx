import { ClosingAction, CodePanel, Ledger, Mark, Section } from "ferramenta-family";
import { Link } from "react-router";

/*
 * The lower half of the landing page: the two APIs side by side, the coverage
 * ledger and the closing call to action. Split from routes/home.tsx to keep
 * each file readable; the measured sections stay with the page.
 */

function MigrationExample() {
  return (
    <CodePanel caption="highlight.ts">
      <span className="kw">import</span> {"{ "}
      <span className="fn">createHighlighter</span>
      {" }"} <span className="kw">from</span> <span className="str">&quot;@ferriki/core&quot;</span>
      ; <span className="cm">// was: "shiki"</span>
      {"\n\n"}
      <span className="kw">const</span> highlighter = <span className="kw">await</span>{" "}
      <span className="fn">createHighlighter</span>({"{"}
      {"\n"}
      {"  "}langs: [<span className="str">&quot;typescript&quot;</span>,{" "}
      <span className="str">&quot;rust&quot;</span>],{"\n"}
      {"  "}themes: [<span className="str">&quot;github-light&quot;</span>,{" "}
      <span className="str">&quot;github-dark&quot;</span>],{"\n"}
      {"});"}
      {"\n\n"}
      <span className="kw">const</span> html = highlighter.
      <span className="fn">codeToHtml</span>(source, {"{"}
      {"\n"}
      {"  "}lang: <span className="str">&quot;typescript&quot;</span>,{"\n"}
      {"  "}theme: <span className="str">&quot;github-dark&quot;</span>,{"\n"}
      {"});"}
    </CodePanel>
  );
}

function RustExample() {
  return (
    <CodePanel caption="main.rs">
      <span className="kw">use</span>{" "}
      <span className="ty">
        ferriki::{"{"}Highlighter, RenderOptions, StandardAssetCatalogs{"}"}
      </span>
      ;{"\n\n"}
      <span className="kw">let</span> assets = <span className="ty">StandardAssetCatalogs</span>
      ::<span className="fn">load_from_root</span>(path)?;{"\n"}
      <span className="kw">let mut</span> highlighter = <span className="ty">Highlighter</span>::
      <span className="fn">builder</span>(){"\n"}
      {"    "}.<span className="fn">with_assets</span>(assets){"\n"}
      {"    "}.<span className="fn">load_languages</span>([
      <span className="str">&quot;rust&quot;</span>]){"\n"}
      {"    "}.<span className="fn">load_themes</span>([
      <span className="str">&quot;github-dark&quot;</span>]){"\n"}
      {"    "}.<span className="fn">build</span>()?;{"\n\n"}
      <span className="kw">let</span> lines = highlighter.
      <span className="fn">highlight_html_lines</span>({"\n"}
      {"    "}source, <span className="str">&quot;rust&quot;</span>,{" "}
      <span className="str">&quot;github-dark&quot;</span>, &amp;
      <span className="ty">RenderOptions</span>::<span className="fn">default</span>(),{"\n"}
      )?;
    </CodePanel>
  );
}

export function CodeSection() {
  return (
    <Section
      id="code"
      title="Keep the same HTML. Change one import."
      intro={
        <>
          For Node.js, Ferriki keeps Shiki&rsquo;s rendered HTML calls and options. From Rust, the
          same engine is a crate with no Node.js in sight.
        </>
      }
      note={
        <>
          What changes and what stays is listed in the{" "}
          <Link to="/guide/migrating-from-shiki">migration guide</Link>.
        </>
      }
    >
      <div className="fam-code-grid">
        <MigrationExample />
        <RustExample />
      </div>
    </Section>
  );
}

const coverage = [
  {
    name: "Shiki's rendered HTML API",
    status: "Covered",
    settled: true,
    detail: "codeToHtml, reusable highlighters, the singleton and language aliases.",
  },
  {
    name: "Standard grammars and themes",
    status: "260 · 65",
    settled: true,
    detail:
      "Ferriki ships catalog metadata. In Node, requested compact payloads download from the release-pinned asset service on first use and are cached locally.",
  },
  {
    name: "Custom TextMate grammars and themes",
    status: "Covered",
    settled: true,
    detail: "Register your own JSON grammars and themes, with embedded languages and injections.",
  },
  {
    name: "Linux, macOS, Windows",
    status: "Native",
    settled: true,
    detail:
      "Linux x64 and arm64 (glibc and musl), macOS on Apple Silicon, Windows x64 and arm64, on Node.js 22.13 or newer.",
  },
  {
    name: "Markdown adapters (rehype, markdown-it)",
    status: "Outside",
    settled: false,
    detail: "Adapters stay in the Markdown layer; Ferromark integrates Ferriki from Rust.",
  },
  {
    name: "Browsers",
    status: "Not a target",
    settled: false,
    detail: "Ferriki runs in Node.js and Rust. Highlight at build or render time on the server.",
  },
];

export function CoverageSection() {
  return (
    <Section
      id="coverage"
      title="What it covers"
      intro="Ferriki is deliberately narrow: native highlighting with rendered HTML and CSS output on every supported Node platform."
      note={<Link to="/evidence/compatibility">Read the compatibility and support policy.</Link>}
    >
      <Ledger entries={coverage} />
    </Section>
  );
}

export function ClosingSection() {
  return (
    <ClosingAction
      id="start"
      title="Bring editor-grade highlighting to your build"
      actions={
        <>
          <Link to="/guide/getting-started" className="fam-btn fam-btn-primary">
            Read the guide <Mark name="arrow" className="icon" size={18} />
          </Link>
          <Link to="/rust/getting-started" className="fam-btn fam-btn-ghost">
            Use it from Rust
          </Link>
        </>
      }
      links={
        <>
          <a href="https://www.npmjs.com/package/@ferriki/core">npm: @ferriki/core</a>
          <span> · </span>
          <a href="https://crates.io/crates/ferriki">crates.io/crates/ferriki</a>
          <span> · </span>
          <a href="https://github.com/sebastian-software/ferriki">GitHub</a>
        </>
      }
    >
      <p className="fam-intro">
        Shiki&rsquo;s contract, the grammars of your editor and a native engine. Install one
        package; there is no WebAssembly to load and no engine to choose.
      </p>
    </ClosingAction>
  );
}
