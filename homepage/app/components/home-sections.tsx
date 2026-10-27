/* cspell:words textnodes syntect */
/* oxlint-disable react/jsx-no-comment-textnodes -- The code sample includes a literal source comment. */
/* oxlint-disable react/no-danger -- HTML is generated from fixed repository samples by Ferriki. */
import { ClosingAction, CodePanel, Ledger, Mark, Section } from "ferramenta-family";
import { Link } from "react-router";

import { grammarCount, standardGrammarCount, supportGrammarCount } from "../data/grammar-catalog";
import macroSample from "../data/macro-sample.json";

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
      title="Code examples, ready before the page ships"
      intro={
        <>
          Write <code>&lt;Code /&gt;</code> right beside the React component it explains. During a
          Vite 8 build, <code>@ferriki/vite</code> turns the example into highlighted HTML and CSS.
          Your readers get the finished block when the page arrives.
        </>
      }
      note={
        <>
          The prepared block below comes from the adapter&rsquo;s actual output. The{" "}
          <a href="https://github.com/sebastian-software/ferriki/blob/main/homepage/app/data/macro-sample-transform.txt">
            full transformed module
          </a>{" "}
          is committed for inspection;{" "}
          <a href="https://github.com/sebastian-software/ferriki/blob/main/homepage/scripts/render-macro-sample.mjs">
            the generator
          </a>{" "}
          verifies both artifacts against <code>@ferriki/vite</code>&rsquo;s output. The{" "}
          <Link to="/guide/build-time-macros">macro guide</Link> covers setup and the rules.
        </>
      }
    >
      <div className="ferriki-macro-sample">
        <figure className="ferriki-highlighted-panel">
          <figcaption>Answer.tsx · Vite input</figcaption>
          <div dangerouslySetInnerHTML={{ __html: macroSample.inputHtml }} />
        </figure>
        <span className="ferriki-macro-arrow" aria-hidden="true">
          →
        </span>
        <figure className="ferriki-highlighted-panel">
          <figcaption>Prepared TypeScript · github-dark</figcaption>
          <div dangerouslySetInnerHTML={{ __html: macroSample.preparedHtml }} />
        </figure>
      </div>
    </Section>
  );
}

function NodeExample() {
  return (
    <CodePanel caption="example.mjs">
      <span className="kw">import</span> {"{ "}
      <span className="fn">createHighlighter</span>
      {" }"} <span className="kw">from</span> <span className="str">&quot;@ferriki/core&quot;</span>
      ;{"\n\n"}
      <span className="kw">const</span> highlighter = <span className="kw">await</span>{" "}
      <span className="fn">createHighlighter</span>({"{"}
      {"\n"}
      {"  "}langs: [<span className="str">&quot;typescript&quot;</span>],{"\n"}
      {"  "}themes: [<span className="str">&quot;github-dark&quot;</span>],{"\n"}
      {"});"}
      {"\n\n"}
      <span className="kw">try</span> {"{"}
      {"\n"}
      {"  "}
      <span className="kw">const</span> html = highlighter.<span className="fn">codeToHtml</span>(
      {"\n"}
      {"    "}
      <span className="str">&quot;const answer = 42;&quot;</span>,{"\n"}
      {"    { lang: "}
      <span className="str">&quot;typescript&quot;</span>, theme:{" "}
      <span className="str">&quot;github-dark&quot;</span> {"}"},{"\n"}
      {"  );"}
      {"\n"}
      {"  "}
      <span className="fn">console</span>.<span className="fn">log</span>(html);{"\n"}
      {"} "}
      <span className="kw">finally</span> {"{"}
      {"\n"}
      {"  "}highlighter.<span className="fn">dispose</span>();{"\n"}
      {"}"}
    </CodePanel>
  );
}

function RustImports() {
  return (
    <>
      <span className="kw">use</span> ferriki::{"{"}
      {"\n"}
      {"    "}
      <span className="ty">Highlighter</span>, <span className="ty">RemoteAssets</span>,{"\n"}
      {"    "}
      <span className="ty">RenderOptions</span>, <span className="ty">StandardAssetCatalogs</span>,
      {"\n"}
      {"    "}
      <span className="fn">render_html</span>,{"\n"}
      {"};"}
      {"\n\n"}
    </>
  );
}

function RustExample() {
  return (
    <CodePanel caption="main.rs · cargo add ferriki --features remote">
      <RustImports />
      <span className="kw">fn</span> <span className="fn">main</span>() -&gt;{" "}
      <span className="ty">Result</span>&lt;(), <span className="ty">Box</span>&lt;
      <span className="kw">dyn</span> <span className="ty">std::error::Error</span>&gt;&gt; {"{"}
      {"\n"}
      {"    "}
      <span className="kw">let mut</span> highlighter = <span className="ty">Highlighter</span>::
      <span className="fn">builder</span>(){"\n"}
      {"        ."}
      <span className="fn">with_assets</span>(<span className="ty">StandardAssetCatalogs</span>::
      <span className="fn">remote</span>({"\n"}
      {"            "}
      <span className="ty">RemoteAssets</span>::<span className="fn">default</span>(){"\n"}
      {"        )?)"}
      {"\n"}
      {"        ."}
      <span className="fn">load_languages</span>([<span className="str">&quot;rust&quot;</span>])
      {"\n"}
      {"        ."}
      <span className="fn">load_themes</span>([<span className="str">&quot;github-dark&quot;</span>
      ]){"\n"}
      {"        ."}
      <span className="fn">build</span>()?;{"\n\n"}
      {"    "}
      <span className="kw">let</span> tokens = highlighter.<span className="fn">highlight</span>(
      {"\n"}
      {"        "}
      <span className="str">&quot;fn main() &#123;&#125;&quot;</span>,{" "}
      <span className="str">&quot;rust&quot;</span>,{" "}
      <span className="str">&quot;github-dark&quot;</span>,{"\n"}
      {"    )?;"}
      {"\n"}
      {"    "}
      <span className="fn">println!</span>(<span className="str">&quot;&#123;&#125;&quot;</span>,{" "}
      <span className="fn">render_html</span>(&amp;tokens, &amp;
      <span className="ty">RenderOptions</span>::<span className="fn">default</span>()));{"\n"}
      {"    "}
      <span className="ty">Ok</span>(()){"\n"}
      {"}"}
    </CodePanel>
  );
}

export function CodeSection() {
  return (
    <Section
      id="code"
      title="Familiar calls, native Rust underneath"
      intro={
        <>
          Start with Shiki-style HTML calls in Node.js, or use the same TextMate engine directly
          from Rust. Pick a language, choose a theme, and give your code a place on the page.
        </>
      }
      note={
        <>
          For Rust projects, add the <code>remote</code> feature to use the release-pinned grammar
          and theme catalog. Start with the <Link to="/guide/getting-started">Node.js guide</Link>,
          the <Link to="/rust/getting-started">Rust guide</Link>, or the{" "}
          <Link to="/guide/migrating-from-shiki">Shiki migration guide</Link>.
        </>
      }
    >
      <div className="fam-code-grid">
        <NodeExample />
        <RustExample />
      </div>
    </Section>
  );
}

const coverage = [
  {
    name: "Shiki-compatible HTML API subset",
    status: "Tested",
    settled: true,
    detail:
      "codeToHtml, reusable highlighters, the singleton, the themes map, language aliases, transformers and decorations.",
  },
  {
    name: "Standard grammars and themes",
    status: `${grammarCount} grammars · 65 themes`,
    settled: true,
    detail: `${standardGrammarCount} standard language and format entries, plus ${supportGrammarCount} support grammars for embeddings and injections. Required dependencies load with the host; optional code-fence languages stay optional.`,
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
      "Render in Node.js or Rust at build time or on the server. Pages receive HTML and CSS ready to display, with highlighting handled before the code reaches the browser.",
  },
];

export function CoverageSection() {
  return (
    <Section
      id="coverage"
      title="Built for the code you publish"
      intro="TypeScript and TSX, Vue, Svelte, Astro, and Angular; Rust, Python, Go, and C/C++; Markdown, MDX, SQL, and configuration files. TextMate grammars follow embedded languages, component expressions, and tagged templates. Bring your own grammar for syntax outside the curated catalog."
      note={
        <>
          <Link to="/evidence/compatibility">Read the compatibility and support policy.</Link>{" "}
          <Link to="/guide/languages-and-themes">Browse every language and theme.</Link>{" "}
          <Link to="/guide/ferriki-vs-prism">See Ferriki and Prism on the same code.</Link>
        </>
      }
    >
      <Ledger entries={coverage} />
    </Section>
  );
}

export function ClosingSection() {
  return (
    <ClosingAction
      id="start"
      title="Give your next build a head start"
      actions={
        <>
          <Link to="/guide/getting-started" className="fam-btn fam-btn-primary">
            Highlight your first block <Mark name="arrow" className="icon" size={18} />
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
        Start with a language and a theme. Ferriki brings the prepared scanners and turns your code
        into HTML and CSS, ready for the page.
      </p>
    </ClosingAction>
  );
}
