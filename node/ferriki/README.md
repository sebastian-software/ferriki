# Ferriki

[![npm version](https://img.shields.io/npm/v/%40ferriki%2Fcore.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@ferriki/core)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](https://github.com/sebastian-software/ferriki#license)
[![Node >= 22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org)

**Beautiful code. Optimization, delivered.** Ship polished code examples in your
docs, CMS, or site build. Ferriki runs its
curated TextMate grammar catalog on a native Rust engine and keeps familiar
Shiki-shaped HTML calls for Node.js. Prepare examples as static HTML, or keep
one highlighter ready for a stream of blocks.

## Compile once. Start optimized.

Your next process can pick up the regex work already done. Powered by Ferroni
2.7, Ferriki delivers precompiled regex programs and optimized static scanner
automata with its standard grammars. They arrive from the CDN, are verified
and cached on disk, and restore Eager optimizations from the first static scan.

Keep the cache between builds to reuse the same downloads across rebuilds and
deployments. Each fresh process restores the prepared automata instead of
rebuilding them from source. This is the default with prefiltering on;
unavailable packages fall back to source, and dynamic patterns remain local.

The first load also caches the unpacked package. Later processes skip
decompression and SHA-256 for unchanged local files, then restore the cached
data directly. Program and group sections share the decoded allocation,
avoiding separate bulk copies. File-state checks detect changes and trigger
verification again.

In our local seven-grammar diagnostic, C++ tokenizer startup dropped from
**about 144 ms to 68 ms**, with execution comparable to ordinary Eager.
Startup includes restoration and the first document; network, file I/O, and
complete builds are outside the timer. See the
[measurements and limits](https://ferriki.dev/evidence/benchmarks#prepared-regex).

The current full Node comparison measures Source Off, Auto, Eager and
Prepared separately. Prepared first use takes **39% less time than Source Eager
on macOS**, with **5% more time on Linux**. Source Off still starts fastest.
See the [separate-mode results](https://ferriki.dev/evidence/benchmarks#four-regex-policies)
for all policies and the historical memory measurements.

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

## Shiki comparisons

The October 25 Blacksmith capture uses the repository build with Ferroni
2.7.2 and prepared standard regex packages. On its 14-file corpus, a reused
highlighter produced the same HTML as Shiki/WASM and ran **3.7× faster on
Linux x86-64** and **4.3× faster on macOS ARM64**. With the decoded cache
already populated, first use was **2.0× / 4.4× faster than Shiki/WASM** on
Linux/macOS. See the
[benchmark report](https://ferriki.dev/evidence/benchmarks) for hosts,
first-use timings, raw results, and measurement limits.

Memory depends on the loaded languages. In the earlier October 24 memory
capture, after 600 documents with 12 languages loaded together, Ferriki's
whole-process RSS was **51–137% higher than Shiki/WASM**. With only the large TypeScript workload, it was **33–55% lower**.
Ferriki loads requested languages and their dependencies; these are separate
workloads, not measurements of the entire grammar catalog. See the
[memory details](https://ferriki.dev/evidence/benchmarks#process-memory).

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
