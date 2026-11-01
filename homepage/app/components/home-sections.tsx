/* cspell:words syntect */
import { useState } from "ardo/react";
import { ArdoLink as Link } from "ardo/runtime";
import {
  FerraAction,
  FerraArticle,
  FerraChoices,
  FerraCode,
  FerraCodePair,
  FerraFeatureGrid,
  FerraRenderedCode,
  FerraSelect,
} from "ferramenta-family/ferra";
import { displayName, family, relationsOf, toolHref, WORKSHOP } from "ferramenta-family/registry";

import { grammarCount, standardGrammarCount, supportGrammarCount } from "../data/grammar-catalog";
import macroSample from "../data/macro-sample.json";
import sample from "../data/sample.json";
import { version } from "../version";
import { ClassHighlightingDemo } from "./class-highlighting-demo";

export function SampleSection() {
  return (
    <FerraArticle
      id="sample"
      title="One file. Three languages."
      introduction="HTML, CSS and JavaScript share a page. Ferriki follows each language into the next, down to the template literal inside the script."
      meta={<Link to="/guide/languages-and-themes">Explore the grammars and themes</Link>}
    >
      <FerraCodePair>
        <FerraCode caption="index.html · source">{sample.input}</FerraCode>
        <FerraRenderedCode caption={`Ferriki v${version} · ${sample.theme}`} html={sample.output} />
      </FerraCodePair>
      <p>
        The highlighted result comes straight from Ferriki. Its tokenizer keeps each embedded
        language in context, so a string inside JavaScript can receive a different treatment from
        the surrounding markup.
      </p>
    </FerraArticle>
  );
}
export function MacroSection() {
  return (
    <FerraArticle
      id="build-time"
      title="Ready before the page ships."
      introduction="Keep an example beside the React component it explains. During a Vite 8 build, Ferriki turns that example into highlighted HTML and CSS."
      meta={<Link to="/guide/build-time-macros">Set up the Vite adapter</Link>}
    >
      <FerraCodePair className="ferriki-macro-sample">
        <FerraRenderedCode caption="Answer.tsx · Vite input" html={macroSample.inputHtml} />
        <FerraRenderedCode
          caption="Prepared TypeScript · github-dark"
          html={macroSample.preparedHtml}
        />
      </FerraCodePair>
      <p>
        The prepared block is the adapter’s actual output. Your readers receive the finished
        example; the browser does not need to run a highlighter.{" "}
        <a href="https://github.com/sebastian-software/ferriki/blob/main/homepage/app/data/macro-sample-transform.txt">
          Inspect the full transformed module
        </a>
        .
      </p>
    </FerraArticle>
  );
}
export function ThemeSection() {
  return (
    <FerraArticle
      id="themes"
      title="Style once. Switch themes freely."
      introduction="Class-based output keeps token roles in the markup and theme rules in a stylesheet. Changing a theme does not mean highlighting the code again."
      meta={<Link to="/guide/class-highlighting">Work with class-based output</Link>}
    >
      <ClassHighlightingDemo />
    </FerraArticle>
  );
}
const examples = {
  node: `import { createHighlighter } from "@ferriki/core";

const highlighter = await createHighlighter({
  langs: ["typescript"],
  themes: ["github-dark"],
});
try {
  const html = highlighter.codeToHtml("const answer = 42;", {
    lang: "typescript", theme: "github-dark",
  });
  console.log(html);
} finally {
  highlighter.dispose();
}`,
  rust: `use ferriki::{
    Highlighter, RemoteAssets, RenderOptions,
    StandardAssetCatalogs, render_html,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut highlighter = Highlighter::builder()
        .with_assets(StandardAssetCatalogs::remote(
            RemoteAssets::default()
        )?)
        .load_languages(["rust"])
        .load_themes(["github-dark"])
        .build()?;
    let tokens = highlighter.highlight(
        "fn main() {}", "rust", "github-dark",
    )?;
    println!("{}", render_html(&tokens, &RenderOptions::default()));
    Ok(())
}`,
};
export function CodeSection() {
  const [runtime, setRuntime] = useState<keyof typeof examples>("node");
  return (
    <FerraArticle
      id="code"
      title="Familiar calls. Native Rust underneath."
      introduction="Start with Shiki-style HTML calls in Node.js, or use the same TextMate engine directly from Rust."
      meta={
        <>
          <Link to="/guide/getting-started">Node.js guide</Link>
          {" · "}
          <Link to="/rust/getting-started">Rust guide</Link>
          {" · "}
          <Link to="/guide/migrating-from-shiki">Migrate from Shiki</Link>
          {" · "}
          <Link to="/guide/ferriki-and-syntect">Ferriki and syntect</Link>
        </>
      }
    >
      <FerraSelect
        label="Runtime example"
        options={[
          { value: "node", label: "Node.js" },
          { value: "rust", label: "Rust" },
        ]}
        value={runtime}
        onChange={(event) => {
          setRuntime(event.target.value === "rust" ? "rust" : "node");
        }}
      />
      <FerraCode caption={runtime === "node" ? "example.mjs" : "main.rs"}>
        {examples[runtime]}
      </FerraCode>
      <p>
        The Rust crate’s <code>remote</code> feature loads the release-pinned grammar and theme
        catalog. Both entry points use the same native engine.
      </p>
    </FerraArticle>
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
    <FerraArticle
      id="coverage"
      title="Built for the code you publish."
      introduction="TypeScript and TSX. Vue, Svelte, Astro and Angular. Rust, Python, Go and C/C++. TextMate grammars follow embedded languages and component expressions."
      meta={
        <>
          <Link to="/evidence/compatibility">Compatibility and support policy</Link>
          {" · "}
          <Link to="/guide/languages-and-themes">Every language and theme</Link>
          {" · "}
          <Link to="/guide/ferriki-vs-prism">Compare Ferriki and Prism</Link>
        </>
      }
    >
      <FerraFeatureGrid
        items={coverage.map((entry) => ({
          heading: entry.name,
          text: (
            <>
              <strong>{entry.status}</strong>
              <p>{entry.detail}</p>
            </>
          ),
        }))}
      />
    </FerraArticle>
  );
}
export function FamilySection() {
  const tool = family.find((entry) => entry.name === "ferriki");
  const related = [
    ...new Map(
      (tool ? relationsOf(tool) : []).map((relation) => [relation.tool.name, relation.tool]),
    ).values(),
  ];
  return (
    <FerraArticle
      id="pipeline"
      title="Good company."
      introduction="Use Ferriki on its own, or pair it with another tool from the workshop. Each engine has its own job and API."
      meta={<a href="https://ferramenta.dev">Meet the Ferramenta family</a>}
    >
      <FerraChoices>
        {related.map((entry) => (
          <article key={entry.name}>
            <h3>
              <a href={toolHref(entry)}>{displayName(entry)}</a>
            </h3>
            <p>{entry.what}</p>
          </article>
        ))}
      </FerraChoices>
    </FerraArticle>
  );
}
export function ClosingSection() {
  return (
    <section className="ferra-editorial-closing" id="start" aria-labelledby="work">
      <h2 id="work">Give your next build a head start.</h2>
      <p>
        Choose a language and a theme. Ferriki brings the prepared scanners and turns your code into
        HTML and CSS, ready for the page.
      </p>
      <div className="ferra-actions">
        <FerraAction href="/guide/getting-started">Highlight your first block</FerraAction>
        <FerraAction variant="secondary" href="/rust/getting-started">
          Start with Rust
        </FerraAction>
      </div>
      <p>
        <a href="https://www.npmjs.com/package/@ferriki/core">npm</a>
        {" · "}
        <a href="https://crates.io/crates/ferriki">Crates.io</a>
        {" · "}
        <a href="https://github.com/sebastian-software/ferriki">GitHub</a>
        {" · "}
        <a href={WORKSHOP.consulting}>Integration and support</a>
      </p>
    </section>
  );
}
