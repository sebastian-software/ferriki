/* cspell:words textnodes syntect */
/* oxlint-disable react/jsx-no-comment-textnodes -- The code sample includes a literal source comment. */
/* oxlint-disable react/no-danger -- HTML is generated from fixed repository samples by Ferriki. */
import { ClosingAction, CodePanel, Ledger, Mark, Section } from "ferramenta-family";
import { Link } from "react-router";

import macroSample from "../data/macro-sample.json";
import { HighlightingFlows } from "./highlighting-flows";

/*
 * The landing page sections that state no measurement: the build-time macro
 * sample, the Node and Rust APIs side by side, the coverage ledger and the
 * closing call to action. Split from routes/home.tsx to keep each file
 * readable; the measured sections stay with the page.
 */

export function MacroSection() {
  return (
    <Section
      id="build-time"
      title="Highlight at build time"
      intro={
        <>
          Write a code example where it is shown: <code>&lt;Code /&gt;</code> from{" "}
          <code>@ferriki/core/react/macro</code> in React, or <code>code()</code> from{" "}
          <code>@ferriki/core/macro</code> in any module. During the Vite 8 build,{" "}
          <code>@ferriki/vite</code> replaces each one with highlighted HTML and its CSS, so the
          browser loads no grammar and no engine.
        </>
      }
      note={
        <>
          <a href="https://github.com/sebastian-software/ferriki/blob/main/homepage/scripts/render-macro-sample.mjs">
            Transformed by scripts/render-macro-sample.mjs
          </a>{" "}
          with <code>@ferriki/vite</code>&rsquo;s default options; the{" "}
          <Link to="/guide/build-time-macros">macro guide</Link> covers setup and the rules.
        </>
      }
    >
      <div className="fam-code-grid ferriki-macro-sample">
        <figure className="ferriki-highlighted-panel">
          <figcaption>Answer.tsx</figcaption>
          <div dangerouslySetInnerHTML={{ __html: macroSample.inputHtml }} />
        </figure>
        <figure className="ferriki-highlighted-panel">
          <figcaption>Answer.tsx as @ferriki/vite emits it</figcaption>
          <div dangerouslySetInnerHTML={{ __html: macroSample.outputHtml }} />
        </figure>
      </div>
    </Section>
  );
}

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
      title="One engine, called from Node.js or from Rust."
      intro={
        <>
          In Node.js, Ferriki keeps Shiki&rsquo;s <code>codeToHtml</code>, reusable highlighters,
          the singleton and their options; coming from Shiki is usually one changed import. In Rust,
          the <code>ferriki</code> crate is the same engine as a library, with no Node.js in the
          process.
        </>
      }
      note={
        <>
          What changes and what stays is listed in the{" "}
          <Link to="/guide/migrating-from-shiki">migration guide</Link>; the{" "}
          <Link to="/rust/getting-started">Rust guide</Link> covers assets and Ferromark. For Rust
          HTML projects evaluating another highlighter, see{" "}
          <Link to="/guide/ferriki-and-syntect">Ferriki and syntect</Link>.
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
    name: "Shiki's HTML API",
    status: "Covered",
    settled: true,
    detail:
      "codeToHtml, reusable highlighters, the singleton, the themes map, language aliases, transformers and decorations.",
  },
  {
    name: "Standard grammars and themes",
    status: "260 · 65",
    settled: true,
    detail:
      "Shiki's catalog. Payloads download on first use from the release-pinned asset service, verified by SHA-256 and cached.",
  },
  {
    name: "Custom TextMate grammars and themes",
    status: "Covered",
    settled: true,
    detail: "Register your own JSON grammars and themes, with embedded languages and injections.",
  },
  {
    name: "Class-based output",
    status: "Covered",
    settled: true,
    detail:
      'Nested scope classes and themes as a stylesheet, through styleMode: "classes" or codeToHtmlWithCss. Switch themes with data-ferriki-theme, without highlighting again.',
  },
  {
    name: "Build-time macros",
    status: "Vite 8",
    settled: false,
    detail:
      "code() and <Code /> become HTML and CSS during the build through @ferriki/vite. Other build tools have no adapter.",
  },
  {
    name: "Rust crate and Ferromark",
    status: "Native",
    settled: true,
    detail:
      "cargo add ferriki gives Rust the same engine, with no Node.js in the process. Ferromark highlights Markdown and MDX code fences with it natively.",
  },
  {
    name: "Linux, macOS, Windows",
    status: "Native",
    settled: true,
    detail:
      "Linux x64 and arm64 (glibc and musl), macOS on Apple Silicon, Windows x64 and arm64, on Node.js 22.13 or newer.",
  },
  {
    name: "Server and build time",
    status: "By design",
    settled: true,
    detail:
      "Ferriki runs in Node.js and Rust, at build or render time. Pages receive HTML and CSS; the browser loads no grammar and no engine.",
  },
];

export function CoverageSection() {
  return (
    <Section
      id="coverage"
      title="What it covers"
      intro="Ferriki is deliberately narrow: highlighting to HTML and CSS, in Node.js, in Rust and in the Vite build."
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
        Three ways in, one native engine: <code>@ferriki/core</code> from npm, the{" "}
        <code>ferriki</code> crate from crates.io, and the build-time macros through{" "}
        <code>@ferriki/vite</code>. There is no WebAssembly to load and no engine to choose.
      </p>
    </ClosingAction>
  );
}

export function FlowSection() {
  return (
    <Section
      id="flows"
      title="From source to highlighted HTML"
      intro="Call the highlighter in a build script or on the server, or let Vite prepare literal examples in your components. Both paths deliver ready-to-display markup."
    >
      <HighlightingFlows />
    </Section>
  );
}
