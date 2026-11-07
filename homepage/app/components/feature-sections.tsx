/* cspell:words syntect */
import { ArdoLink as Link } from "ardo/runtime";
import {
  MonoCredit,
  MonoLeadIn,
  MonoPassage,
  MonoProofs,
  MonoSection,
  MonoTerms,
} from "ferramenta-family/monografie";

import { grammarCount } from "../data/grammar-catalog";
import { standardGroups } from "../data/grammar-groups";
import { nodeVersion, rustVersion, themeCount } from "../version";
import { agreement } from "./homepage-data";
import { CodeCards, Company, ThemeSwitch } from "./homepage-specimens";

/* The homepage's later chapters: themes, code, compatibility, coverage and the
   rest of the workshop. The published anchors (#themes, #code, #coverage,
   #pipeline) stay where links expect them. */

export function Themes() {
  return (
    <MonoSection
      id="themes"
      title="Style once. Switch themes freely."
      standfirst="Class-based output keeps the token names in the markup and the colors in a stylesheet. Another theme is another rule, not another highlighting run."
    >
      <MonoPassage
        note={{
          term: "Class-based output",
          children: "Each token carries class names; a stylesheet decides its color.",
        }}
      >
        <p>
          <MonoLeadIn>Inline colors are</MonoLeadIn> the simplest output: every token carries its
          color in a style attribute. That works until a site needs a dark mode, a second theme or
          one color of its own. Then every code block has to be highlighted again for each look.
        </p>
      </MonoPassage>
      <p>
        With <code>codeToHtmlWithCss</code>, Ferriki writes each token&rsquo;s scope into its
        classes and returns the themes as CSS. Dark mode becomes one attribute on the page, and your
        own stylesheet can restyle a single kind of token, as the second switch shows.
      </p>
      <ThemeSwitch />
      <p>
        <Link to="/guide/class-highlighting">Work with class-based output</Link>
      </p>
    </MonoSection>
  );
}

export function Code() {
  return (
    <MonoSection
      id="code"
      title="Familiar calls, native underneath."
      standfirst="Start with Shiki-style calls in Node.js, or use the engine directly from Rust."
    >
      <p>
        <MonoLeadIn>Coming from Shiki,</MonoLeadIn> the calls will look familiar:{" "}
        <code>createHighlighter</code>, <code>codeToHtml</code>, the themes map, transformers and
        decorations. Ferriki covers that HTML API with its own native engine. It runs in Node.js and
        in Rust, not in the browser; by the time a page loads, its work is done.
      </p>
      <MonoPassage
        note={{
          side: "right",
          term: "Compiled module",
          children:
            "A binary built for each platform, installed with the npm package. No build step on your side.",
        }}
      >
        <p>
          The npm package brings a compiled binary for Linux, macOS on Apple Silicon and Windows.
          The Rust crate needs no Node.js at all, and its optional <code>remote</code> feature
          downloads the same release-pinned grammars and themes.
        </p>
      </MonoPassage>
      <CodeCards rust={rustVersion} node={nodeVersion} />
      <p>
        <Link to="/guide/migrating-from-shiki">Migrate from Shiki</Link>
        {" · "}
        <Link to="/guide/ferriki-and-syntect">Ferriki and syntect</Link>
        {" · "}
        <Link to="/guide/api">API overview</Link>
      </p>
    </MonoSection>
  );
}

export function Compatibility() {
  return (
    <MonoSection
      id="compatibility"
      title="The same HTML as Shiki."
      standfirst={`On our ${agreement.of} repository files, Ferriki’s HTML matched Shiki’s byte for byte.`}
    >
      <p>
        <MonoLeadIn>Compatibility is checked,</MonoLeadIn> not claimed. Shiki&rsquo;s own test suite
        runs unchanged against Ferriki&rsquo;s engine from a pinned copy in the repository. The
        tokenizer is a mechanical port of vscode-textmate, the library inside VS Code, and is
        checked against its test cases. Tests outside Ferriki&rsquo;s scope are listed with their
        reasons instead of being skipped quietly.
      </p>
      <MonoProofs
        items={[
          {
            label: "Repository files with HTML identical to Shiki’s",
            value: `${agreement.same} / ${agreement.of}`,
          },
        ]}
      />
      <MonoCredit>
        Measured {agreement.measured} with Ferriki {agreement.ferriki} and Shiki {agreement.shiki},
        using Oniguruma in WebAssembly as Shiki&rsquo;s engine.{" "}
        <Link to="/evidence/compatibility">What compatibility covers</Link>
      </MonoCredit>
    </MonoSection>
  );
}

export function Coverage() {
  return (
    <MonoSection
      id="coverage"
      title="Built for the code you publish."
      standfirst={`${grammarCount} grammars and ${themeCount} themes ship as standard packages, from TypeScript and Rust to Vue, Svelte and Astro.`}
    >
      <p>
        <MonoLeadIn>Component formats</MonoLeadIn> are where highlighters tend to struggle. A Vue or
        Svelte file holds markup, styles and script; an Astro file adds expressions inside the
        markup. TextMate grammars describe those languages inside one another, and Ferriki follows
        them. Grammars that only serve as building blocks, such as the expressions inside an Angular
        template, load with the language that needs them.
      </p>
      <MonoTerms
        className="mono-wide fk-gap"
        columns={3}
        prose
        items={standardGroups.map((group) => ({
          term: `${group.title}, ${group.languages.length}`,
          description: group.description,
        }))}
      />
      <p>
        Your own grammars and themes register as JSON, with embedded languages and injections.{" "}
        <Link to="/guide/languages-and-themes">Every language and theme</Link>
      </p>
    </MonoSection>
  );
}

export function Family() {
  return (
    <MonoSection
      id="pipeline"
      title="Good company."
      standfirst="Ferriki works on its own. These are the places where it meets the rest of the workshop."
    >
      <p>
        Each engine in the workshop has its own job and its own API, and none needs another beside
        it. Where two fit together, the cards below say how.
      </p>
      <Company />
    </MonoSection>
  );
}
