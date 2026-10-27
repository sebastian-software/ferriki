# Ferriki

[![npm version](https://img.shields.io/npm/v/%40ferriki%2Fcore.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@ferriki/core)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](https://github.com/sebastian-software/ferriki#license)
[![Node >= 22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org)

**Beautiful code. Head start included.** Native, Oniguruma-compatible syntax
highlighting for your docs, blog, or CMS, with familiar Shiki-style HTML calls
in Node.js. **Precompiled CDN packages are ready for production and enabled
by default for standard grammars.** Render a page of examples or keep one
highlighter ready for the next block.

## We ship the optimization

Native Oniguruma compatibility and precompiled delivery work together in
Ferriki's production default. Standard language packages carry **compiled
regex programs and optimized static scanner automata** alongside the syntax
definition. The optimization becomes part of the download.
Matching stays in Ferroni's native, Oniguruma-compatible engine, with no
translation into JavaScript RegExp. Capture-dependent end and while patterns
remain dynamic to preserve TextMate behavior.

Powered by Ferroni 2.8, we move static regex compilation and Eager scanner
preparation into the asset pipeline. The CDN delivers that prepared work
alongside the grammar. Each new process restores the scanners it needs,
with their static optimizations already in place.

Keep the disk cache between builds and you keep the download, the unpacked
packages, and the preparation. Prepared packages are the default with
prefiltering on. Missing packages fall back to source, and dynamic patterns
remain local. Only requested languages and required dependencies load;
optional code-fence languages stay optional.

**Sponsored by [Sebastian Software](https://sebastian-software.de/)**,
which currently covers Ferriki's CDN costs.

In our fourteen-file Blacksmith corpus, Prepared reached first HTML in about
half Source Eager's time, while keeping its execution speed. Startup stayed
within 6% of unoptimized Source Off on Linux and macOS.

[See the separate-mode results](https://ferriki.dev/evidence/benchmarks#four-regex-policies).

## Syntax that follows your code

TypeScript and TSX, Vue, Svelte, Astro, and Angular; Rust, Python, Go, Java,
and C/C++; Markdown, MDX, SQL, JSON, YAML, and TOML are all included. TextMate
grammars follow embedded languages, component expressions, and tagged
templates. Registered languages also highlight inside supported Markdown fences.

The curated catalog has **67 standard language and format entries**, **27
support grammars** for embeddings and injections, and **65 themes**. Add your
own TextMate grammars for syntax outside the catalog.
[Browse the complete coverage](https://ferriki.dev/guide/languages-and-themes).

## Requirements and install

Ferriki is ESM-only and requires Node.js 22.13.0 or newer. npm installs the
optional native package for your platform: Linux x64/arm64 with glibc or musl,
macOS on Apple Silicon, and Windows x64/arm64. Keep optional dependencies
enabled in production installs.

```sh
npm install @ferriki/core
```

Grammar and theme payloads are downloaded from `assets.ferriki.dev` the first
time they are loaded, pinned to this release, verified by SHA-256, and cached
in `node_modules/.cache/ferriki`. For offline use, populate the cache before
the build or point `FERRIKI_ASSETS_BASE_URL` at a mirror. Set
`FERRIKI_ASSETS_REMOTE=0` to use the cache only. See [asset loading](https://github.com/sebastian-software/ferriki/blob/main/docs/asset-loading.md)
for cache, proxy, and certificate settings.

## See a highlighted page

Save this complete ESM file as `highlight.mjs`:

```js
import { writeFile } from "node:fs/promises";
import { codeToHtml } from "@ferriki/core";

const html = await codeToHtml("const answer = 42;", {
  lang: "javascript",
  theme: "github-dark",
});

await writeFile("highlighted.html", html);
console.log("Saved highlighted.html. Open it in a browser to preview your code.");
```

Run `node highlight.mjs`, then open `highlighted.html`. The one-shot API loads
the language and theme on first use and reuses a process-local highlighter on
later calls.

## A head start you can measure

Same fourteen files. Same HTML as Shiki/WASM. Less time spent highlighting.

| October 27 Blacksmith capture | Linux x86-64 | macOS ARM64 |
| --- | ---: | ---: |
| First HTML vs. Shiki/WASM | **4.2× faster** | **5.5× faster** |
| Repeated highlighting vs. Shiki/WASM | **3.7× faster** | **4.4× faster** |

Measured with Ferriki 1.3.0 and Ferroni 2.8.0. First HTML includes imports,
setup, and rendering in a fresh process with asset and decoded caches already
populated; downloads, first cache fill, and process creation are excluded.
These are highlighting measurements, not total build times.
[See the hosts, raw results, and all four modes](https://ferriki.dev/evidence/benchmarks#four-regex-policies).

Memory depends on the languages you load. After 600 documents across twelve
languages, Prepared's whole-process RSS was **45% lower than Shiki/WASM** on
both hosts. For the large TypeScript workload, it was **67–69% lower**. These
are six-process medians per contender and workload, with identical HTML.
[See the memory measurements](https://ferriki.dev/evidence/benchmarks#process-memory-by-policy).

## What goes over the wire

Prepared scanners increase the first download: Rust needs about **58 kB in
total versus 18 kB for the grammar alone**; TypeScript with required
embeddings needs **4.65 MB versus 0.54 MB**. Markdown needs **1.97 MB versus
61 kB**, with optional code-fence languages still unloaded.

These compare Ferriki's grammar-only CDN payloads with the same grammars plus
prepared programs and automata, in decimal units, excluding themes and HTTP
overhead. Keep the cache across builds to reuse downloads. Decoded data also
uses additional disk space. [See exact sizes and the source-definition comparison](https://github.com/sebastian-software/ferriki/blob/main/docs/benchmarks/precompiled-patterns/download-footprint-2026-10-27.md).

## Reuse a highlighter

For a CMS worker or site build, load the languages and themes you need once.
Rendering with loaded assets is synchronous. Create one highlighter per worker
and dispose it when the worker shuts down.

```js
import { createHighlighter } from "@ferriki/core";

const highlighter = await createHighlighter({
  langs: ["javascript", "typescript"],
  themes: ["github-light", "github-dark"],
});

try {
  const html = highlighter.codeToHtml("const answer: number = 42;", {
    lang: "typescript",
    theme: "github-dark",
  });
  console.log(html);
} finally {
  highlighter.dispose();
}
```

`getSingletonHighlighter()` shares one highlighter per process, and the one-shot
functions use it. Custom languages and themes use Shiki's TextMate registration
shapes in `langs` and `themes` and are validated before they reach the native
engine. Languages embedded by a grammar load with it; lazy embeddings load
after an explicit `loadLanguage`.

For tuning repeated work and short-lived highlighters, see [the prefilter guide](https://github.com/sebastian-software/ferriki/blob/main/docs/ferriki-api.md#choosing-the-regex-prefilter).

## Languages and themes

Ferriki maintains its own curated catalog of standard TextMate grammars,
including embedded dependencies, and 65 themes. Use `bundledLanguages` and
`bundledLanguagesAlias` to discover available IDs and aliases. The
[grammar guide](https://github.com/sebastian-software/ferriki/blob/main/docs/grammars.md)
covers catalog coverage and external imports. For a local grammar, run:

```sh
npm exec -- ferriki grammar fetch ./grammar.tmLanguage.json \
  --name example --output ./example.ferriki.json
```

The importer also accepts URLs and commit-pinned GitHub sources. Review a
grammar's license before redistributing it.

## Class-based output and theme maps

Use `styleMode: "classes"` for nested TextMate scope classes, or
`codeToHtmlWithCss()` to return highlighted HTML with its matching CSS. An
ordered `themes` map can switch palettes on prepared markup without highlighting
again. The [class-based highlighting guide](https://github.com/sebastian-software/ferriki/blob/main/docs/class-highlighting.md)
shows complete HTML and stylesheet examples for custom classes and theme
switching.

## Transformers

Transformer and decoration callbacks run in JavaScript and receive typed token
and HAST data. The native engine handles decoration ranges, token boundaries,
and wrapping. Shiki's `@shikijs/transformers` notation helpers for focus,
highlights, diffs, and word highlights work with them.

## Build-time macros

[`@ferriki/vite`](https://github.com/sebastian-software/ferriki/tree/main/node/vite)
turns `code()` and React `<Code />` calls into highlighted output during a Vite
8 build. The highlighter runs during the build, and the default React component
uses a small framework-free presentation module to display the prepared output.
The [Vite guide](https://github.com/sebastian-software/ferriki/tree/main/node/vite)
has a complete React setup and advanced SSR details.

## Rust

The same native engine is available as the [`ferriki` crate](https://crates.io/crates/ferriki).
See the [Rust API guide](https://github.com/sebastian-software/ferriki/blob/main/docs/rust-api.md).

## Compatibility

Ferriki follows Shiki v4.4.3. Shiki's tests run unchanged against the native
addon from a pinned mirror, each classified as supported, deferred, or out of
scope; the tokenizer is checked against the complete vscode-textmate v9.3.2
oracle. Node's public output is HTML; transformer callbacks can inspect token
and HAST data. Terminal ANSI input is rejected with `ShikiError` instead of
being rendered. See the [compatibility policy](https://github.com/sebastian-software/ferriki/blob/main/docs/compatibility.md)
and [Shiki migration guide](https://github.com/sebastian-software/ferriki/blob/main/docs/migrations/shiki-to-ferriki.md).

## Documentation

- [Ferriki API reference](https://github.com/sebastian-software/ferriki/blob/main/docs/ferriki-api.md)
- [Shiki migration guide](https://github.com/sebastian-software/ferriki/blob/main/docs/migrations/shiki-to-ferriki.md)
- [Compatibility policy](https://github.com/sebastian-software/ferriki/blob/main/docs/compatibility.md)
- [Troubleshooting](https://github.com/sebastian-software/ferriki/blob/main/docs/troubleshooting.md): native-loader and offline failures
- [Code example authoring](https://github.com/sebastian-software/ferriki/blob/main/docs/code-example-authoring.md): focus, highlights, diffs, and copy behavior
- [ferriki.dev](https://ferriki.dev): guides and benchmarks

## License

Licensed under either of [MIT](https://github.com/sebastian-software/ferriki/blob/main/LICENSE-MIT)
or [Apache-2.0](https://github.com/sebastian-software/ferriki/blob/main/LICENSE-APACHE)
at your option.

<!-- ferramenta-family:start -->

**ferriki** is part of the [Ferramenta](https://ferramenta.dev) family — A family of Rust tools.

Siblings: [ferroni](https://ferroni.dev) — Oniguruma-compatible regex engine · [ferromark](https://ferromark.dev) — Markdown to HTML, sanitized by default · [ferrolex](https://github.com/sebastian-software/ferrolex) — Spell checking for text and code · [ferrocat](https://ferrocat.dev) — Translation catalog engine · [ferralk](https://github.com/sebastian-software/ferralk) — Glob matching and parallel filesystem walking · [ferrugo](https://github.com/sebastian-software/ferrugo) — PDF previews for untrusted files · [palamedes](https://palamedes.dev) — Internationalization for TypeScript applications · [dalo](https://dalo.sh) — Your team's agent setup, versioned like code · [ardo](https://ardo-docs.dev) — Documentation sites built with React.
<!-- ferramenta-family:end -->
