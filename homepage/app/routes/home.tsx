import type { ArdoMetaFunction } from "ardo/runtime";

import { Fragment } from "ardo/react";
import { ArdoLink as Link } from "ardo/runtime";
import {
  MonoAction,
  MonoClosing,
  MonoColophon,
  MonoEngraving,
  MonoOpening,
} from "ferramenta-family/monografie";
import { displayName, family, WORKSHOP } from "ferramenta-family/registry";

import { Code, Compatibility, Coverage, Family, Themes } from "../components/feature-sections";
import { agreement } from "../components/homepage-data";
import { BuildTime, Explainer, Prepared, Speed } from "../components/story-sections";
import { grammarCount } from "../data/grammar-catalog";
import { nodeVersion, releaseLine, rustVersion, themeCount } from "../version";

// oxlint-disable-next-line react/only-export-components -- Ardo reads route metadata.
export const meta: ArdoMetaFunction = () => [
  { title: "Ferriki — Syntax highlighting with your editor’s grammars" },
  {
    name: "description",
    content:
      "Ferriki highlights code with the TextMate grammars and themes your editor uses: a native Rust engine with Shiki-style calls for Node.js, a Rust crate and a Vite adapter that highlights at build time.",
  },
];
// oxlint-disable-next-line react/only-export-components -- Ardo reads the route layout.
export const handle = { layout: "bare" };

const member = family.find((entry) => entry.name === "ferriki");
if (member === undefined) throw new Error("Ferriki is missing from the family registry.");
const tool = member;

function Actions() {
  return (
    <>
      <MonoAction href="/guide/getting-started" primary detail="npm install @ferriki/core">
        Start with Node.js
      </MonoAction>
      <MonoAction href="/rust/getting-started" detail="cargo add ferriki">
        Start with Rust
      </MonoAction>
    </>
  );
}

function Opening() {
  return (
    <MonoOpening
      product="ferriki"
      instrumentLabel="Ferriki's instrument: a token register on a machined steel plate. Plain engraved token groups run along a guide, pass under a registration head that holds a rust-brown theme cassette, and leave inlaid in brown, green and blue."
      kicker={`${displayName(tool)} ${releaseLine}, ${tool.what.toLowerCase()} for Node.js, Rust and Vite`}
      title="Your editor’s colors, on your page."
      subtitle="Highlighted natively, with Shiki’s familiar calls."
      standfirst="Ferriki turns source code into colored HTML for documentation sites, blogs, component libraries and build tools. It reads the TextMate grammars and themes that VS Code uses, follows languages nested inside one another, and runs in native Rust: from Node.js, from a Rust program, or inside your Vite build."
      actions={<Actions />}
      facts={[
        {
          value: (
            <>
              <em>{agreement.same}</em> of {agreement.of}
            </>
          ),
          label: "repository files with the same HTML as Shiki",
        },
        { value: <em>{grammarCount}</em>, label: "grammars in the standard packages" },
        { value: <em>{themeCount}</em>, label: "themes, as inline styles or as CSS" },
        {
          value: `Node.js ${nodeVersion}+`,
          label: `Rust ${rustVersion}+, MIT or Apache-2.0`,
        },
      ]}
    />
  );
}

// Keys are written out: minified builds do not keep function names.
const chapters = [
  { key: "explainer", Chapter: Explainer },
  { key: "speed", Chapter: Speed },
  { key: "prepared", Chapter: Prepared },
  { key: "build-time", Chapter: BuildTime },
  { key: "themes", Chapter: Themes },
  { key: "code", Chapter: Code },
  { key: "compatibility", Chapter: Compatibility },
  { key: "coverage", Chapter: Coverage },
  { key: "family", Chapter: Family },
];

function Origin() {
  return (
    <section aria-label="Origin">
      <div className="mono-axis">
        <MonoColophon>
          {tool.proof} Ferriki checks itself against Shiki&rsquo;s tests, and its tokenizer is a
          port of Microsoft&rsquo;s vscode-textmate. It is an independent project, one of the
          Ferramenta engines, made by {WORKSHOP.name} in {WORKSHOP.place}.
        </MonoColophon>
      </div>
    </section>
  );
}

/** The actions again, under the published anchors #start and #work. */
function Closing() {
  return (
    <div id="start">
      <MonoClosing
        title={<span id="work">Give your next build a head start.</span>}
        standfirst="Choose a language and a theme. Ferriki brings the prepared scanners and turns your code into HTML and CSS, ready for the page."
        actions={<Actions />}
        links={
          <>
            <a href="https://www.npmjs.com/package/@ferriki/core">npm</a>
            <a href="https://crates.io/crates/ferriki">crates.io</a>
            <a href="https://github.com/sebastian-software/ferriki">GitHub repository</a>
            <Link to="/guide/getting-started">Documentation</Link>
            <a href={WORKSHOP.consulting}>Integration and support</a>
          </>
        }
      />
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <Opening />
      {chapters.map(({ key, Chapter }, index) => (
        <Fragment key={key}>
          <MonoEngraving seed={index + 1} />
          <Chapter />
        </Fragment>
      ))}
      <MonoEngraving seed={chapters.length + 1} />
      <Origin />
      <Closing />
    </>
  );
}
