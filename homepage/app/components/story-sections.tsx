import { ArdoLink as Link } from "ardo/runtime";
import { MonoCredit, MonoPassage, MonoSection, MonoTerms } from "ferramenta-family/monografie";

import { corpus, memorySaved, memoryWorkload } from "./homepage-data";
import { DiagnosticsCards, FirstUseTable, MacroSheets } from "./homepage-specimens";
import { SpeedChart } from "./speed-chart";
import { TokenRegister } from "./token-register";

/* The homepage's first chapters: what a highlighter does, speed, the prepared
   packages and build-time highlighting. The published anchors (#sample,
   #evidence, #prepared-regex, #build-time) stay where links expect them. */

export function Explainer() {
  return (
    <MonoSection id="sample" title="Code is easier to read in color.">
      <MonoPassage
        note={{
          term: "Syntax highlighting",
          children: "Coloring source code by what each part is: a keyword, a string, a comment.",
        }}
      >
        <p>
          Every code example in documentation, a blog post or a product page reaches its reader as
          plain characters. Color shows where a string ends, which word is a keyword and which line
          is only a comment. Editors have done this for decades. A web page has to do it too, for
          every language on the page, including the CSS and JavaScript that live inside an HTML
          file.
        </p>
      </MonoPassage>
      <MonoPassage
        note={{
          side: "right",
          term: "TextMate grammar",
          children:
            "A file of patterns that names each piece of a language. VS Code and many other editors read them.",
        }}
      >
        <p>
          Most editors learned their languages from TextMate grammars. A grammar reads code the way
          a person skims it and gives every piece a name, such as{" "}
          <code>string.quoted.double.js</code>. A theme then maps those names to colors. Shiki
          brought the same grammars and themes to the web, so a code block on a page could look the
          way it does in VS Code.
        </p>
      </MonoPassage>
      <p>
        Ferriki is a highlighter built on that machinery. It reads the same grammars and themes,
        follows one language into the next and returns HTML that is ready for the page. Its engine
        is written in Rust; Node.js and Vite use the same engine through a compiled module.
      </p>
      <TokenRegister />
      <p>
        The template expression is selected to begin with. The grammar knows that <code>name</code>{" "}
        sits in a placeholder, inside a template string, inside JavaScript, inside a script element,
        inside HTML. That nesting is why the variable keeps its own color while the text around it
        is colored as a string.
      </p>
    </MonoSection>
  );
}

export function Speed() {
  return (
    <MonoSection
      id="evidence"
      title="Less time for every page of code."
      standfirst={`On ${corpus.files} files in ${corpus.languages} languages, Ferriki needed less time than Shiki with either of its engines. Prism was faster still, with simpler grammars that see less of the code.`}
    >
      <MonoPassage
        note={{
          figure: corpus.files,
          children: "files, a short example and a large one for each language",
        }}
      >
        <p>
          A documentation build highlights every code block on every page, often thousands of them,
          and does it again after each change. A server that renders articles on request highlights
          while a reader waits. Every millisecond saved is saved many times over.
        </p>
      </MonoPassage>
      <p>
        Ferriki does the work Shiki does, with the same grammars and themes. The difference is where
        the matching runs: in native Rust, rather than in WebAssembly or in regular expressions
        translated to JavaScript. Prism takes another road. Its grammars are written for speed and
        recognize fewer details, so a parameter or an embedded language may stay plain;{" "}
        <Link to="/guide/ferriki-vs-prism">the Prism comparison</Link> shows the same examples side
        by side.
      </p>
      <SpeedChart />
      <MonoPassage
        note={{
          side: "right",
          figure: `${memorySaved}%`,
          children: "less memory than Shiki's WASM engine for the same renders",
        }}
      >
        <p>
          Memory tells a similar story. After {memoryWorkload.renders} renders of{" "}
          {memoryWorkload.files} repository files, the whole Ferriki process used about{" "}
          {memorySaved}% less memory than the same work with Shiki&rsquo;s WASM engine, on both
          machines.
        </p>
      </MonoPassage>
    </MonoSection>
  );
}

const steps = [
  {
    term: "Compile before delivery",
    description: "Ferroni compiles the static patterns and prepares their scanners.",
  },
  {
    term: "Deliver the package",
    description: "Each requested grammar arrives with that work inside it.",
  },
  {
    term: "Keep it on disk",
    description: "Verified downloads stay in your cache from one build to the next.",
  },
  {
    term: "Restore, then highlight",
    description: "A fresh process restores the scanners and starts on your code.",
  },
];

/** The cold start the preparation pays off in, and what it costs. */
function FirstUse() {
  return (
    <>
      <MonoPassage
        note={{
          side: "right",
          term: "First use",
          children: "Loading, setting up and highlighting in a process that has only just started.",
        }}
      >
        <p>
          The difference shows when a process starts cold. With the downloads already in the cache,
          a fresh process highlights the repository files sooner with the prepared packages than
          when it prepares the same scanners itself, and much sooner than Shiki.
        </p>
      </MonoPassage>
      <FirstUseTable />
      <p>
        Preparation has a price: a prepared package is a larger download than its grammar alone, and
        the unpacked data takes disk space. Only the languages you request are fetched, and a
        missing package falls back to the grammar source.{" "}
        <Link to="/evidence/benchmarks#shared-language-packages">
          Download sizes for each language
        </Link>
      </p>
      <MonoCredit>
        Sponsored by <a href="https://sebastian-software.de/">Sebastian Software</a>, which
        currently covers Ferriki&rsquo;s CDN costs.
      </MonoCredit>
    </>
  );
}

export function Prepared() {
  return (
    <MonoSection
      id="prepared-regex"
      title="We ship the preparation."
      standfirst="Standard language packages arrive with their patterns already compiled, so a new process can start highlighting instead of preparing."
    >
      <MonoPassage
        note={{
          term: "Regular expression",
          children: "A pattern that describes text. A grammar is made of hundreds of them.",
        }}
      >
        <p>
          A grammar is mostly regular expressions, hundreds of them for a language like TypeScript.
          Before the first line gets its colors, each pattern has to be compiled, and the patterns
          that compete at each position are gathered into scanners. Most highlighters repeat that
          work in every new process: on every build, in every serverless function, in every test
          run.
        </p>
      </MonoPassage>
      <p>
        Ferriki moves it earlier. Ferroni, its regular-expression engine, compiles the static
        patterns and prepares their scanners when a language package is built. The package carries
        that work to your machine, the disk cache keeps it, and a fresh process restores it instead
        of rebuilding it. Patterns that depend on text captured earlier in the line still compile on
        the spot, as TextMate requires.
      </p>
      <MonoTerms className="fk-gap" items={steps} prose />
      <p>
        The engine reports what it did. Here is the HTML file from above, highlighted twice by fresh
        highlighters: once with the prepared packages, once from the grammar source.
      </p>
      <DiagnosticsCards />
      <FirstUse />
    </MonoSection>
  );
}

export function BuildTime() {
  return (
    <MonoSection
      id="build-time"
      title="Finished before the page ships."
      standfirst="Keep a code example beside the React component that explains it. While Vite builds the site, Ferriki turns the example into highlighted HTML and CSS."
    >
      <MonoPassage
        note={{
          term: "Build time",
          children: "When your site is compiled, before any visitor arrives.",
        }}
      >
        <p>
          Highlighting in the browser means sending a highlighter, its grammars and its themes to
          every visitor, then waiting while they load. For examples that never change, that work can
          happen once, while the site is built. The <code>@ferriki/vite</code> adapter finds the{" "}
          <code>code()</code> calls and <code>&lt;Code /&gt;</code> elements in your components,
          highlights them during the build and leaves finished markup in their place.
        </p>
      </MonoPassage>
      <MacroSheets />
      <p>
        The adapter works with Vite 8. Other build tools have no adapter yet; they can call Ferriki
        from Node.js like any other script.{" "}
        <Link to="/guide/build-time-macros">Set up the Vite adapter</Link>
      </p>
    </MonoSection>
  );
}
