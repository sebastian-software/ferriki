# Class-based highlighting: experimental findings

Recorded September 30, 2026. This is a research result, not an accepted ADR or
a public API contract. The reproducible prototype lives in
[`node/experiments/class-highlighting`](../../node/experiments/class-highlighting/README.md).

## Result

The nested model best meets the stated goal in this experiment: simple category
classes for common styling, ordinary ancestor/child selectors for detailed
control, and preservation of scope order and repeated scopes. All 20 curated
CSS tasks pass, and all 175,164 browser token/theme checks match the reference.

The hybrid model preserves the same reference styles in fewer DOM nodes, but
two context tasks require generated path identifiers. It remains a viable option
when DOM size matters more than expressing every distinction in readable CSS.

The tested flat model loses information. It solves 18/20 tasks and has ten
computed-style mismatches, including eight in real Everforest themes and two
in the synthetic context theme. The real mismatches affect whitespace in the
shell fixture; they are not evidence of widespread visibly incorrect output.

**The measured 20/20 is not a population-level 95% usability claim.** The catalog
is curated, the expected targets are scope-based, and there was no independent
user study. It is evidence that the nested representation supports the tested
common and detailed operations without path hashes or `!important`.

## Evidence

The corpus contains 23 cases: authored probes and the first 24 lines of 14
existing repository/upstream source files. It covers 14 real languages and one
synthetic grammar, 65 shipped themes and one synthetic theme, 723 distinct
scope paths, and 2,654 raw tokens. Fixture splits are 14 development / 9 holdout;
task splits are 14 development / 6 holdout.

Native raw scope paths and boundaries match Shiki's installed TextMate
implementation on every corpus line. Native themed output and Shiki agree over
761,442 UTF-16 code units, comparing foreground and font style independently of
token merging. References are Shiki v4.4.3, native vscode-textmate v9.3.2, and
the installed `@shikijs/vscode-textmate` 10.0.2; these are deliberately recorded
separately rather than claimed to be the same implementation version.

Computed browser foreground, italic, bold, underline, and strikethrough were
checked in Chromium 154. Theme switches retained the existing token DOM nodes,
and every model preserved the source text. A separate handwritten CSS palette
passed light/dark checks without loading a TextMate theme or changing tokens.

| Model                         | Readable CSS tasks | With technical fallback | Browser style mismatches | Lost path groups |
| ----------------------------- | -----------------: | ----------------------: | -----------------------: | ---------------: |
| Flat classes                  |              18/20 |                   18/20 |               10/175,164 |               21 |
| Nested scopes + token classes |              20/20 |                   20/20 |                0/175,164 |                0 |
| Flat classes + full-path ID   |              18/20 |                   20/20 |                0/175,164 |                0 |

All models solve all 14 development tasks. Nested solves all six holdout tasks;
flat and hybrid solve four directly. The two additional tasks distinguish
reversed ancestor order and repeated ancestors. Hybrid resolves these through
its path dictionary; the tested flat classes cannot distinguish their targets.

## Why hierarchy matters

These two scope paths occur in the real shell fixture:

```text
source.shell
  meta.scope.if-block.shell
    meta.function.shell
      meta.function.body.shell
        meta.statement.shell
```

```text
source.shell
  meta.function.shell
    meta.function.body.shell
      meta.scope.if-block.shell
        meta.statement.shell
```

Both produce the same unordered set of scope/context classes. Everforest Dark
nevertheless assigns `#a7c080` to the first path and `#d3c6aa` to the second.
An information-losing class set cannot recover this distinction by changing
CSS specificity. Repetition is another independent ambiguity: `meta.a meta.a`
and `meta.a` collapse if classes are deduplicated.

The nested representation retains these relationships in the DOM. Simple
operations still use one category selector:

```css
.tok-string {
  color: var(--syntax-string);
}

.tok-entity-name-function {
  color: var(--syntax-function);
}
```

Detailed operations can use ordinary child selectors, as in the synthetic
order task:

```css
.scope-meta-a > .scope-meta-b > .scope-entity-name-probe > .token {
  color: #123456;
}
```

The prototype distinguishes token membership (`tok-*`), ancestor context
(`ctx-*`), the innermost scope (`leaf-*`), and actual scope wrappers (`scope-*`).
It emits every dotted prefix. These names and the exhaustive class set are
experimental; reducing their size and documenting their meaning remain API
design work. Literal hyphens are encoded separately from dotted hierarchy to
avoid name collisions.

## Size tradeoff

Counts below aggregate all 23 case fragments, not one typical code block.
HTML includes diagnostic token attributes. Gzip is measured over the combined
corpus. Per-theme CSS covers every observed scope path and resets each supported
style property explicitly; it is not an optimized production stylesheet.

| Model  | HTML bytes | Gzip HTML | Spans | Gzip CSS per theme |
| ------ | ---------: | --------: | ----: | -----------------: |
| Flat   |  1,379,654 |    46,634 | 2,654 |      18,677–20,029 |
| Nested |  1,808,895 |    62,015 | 5,057 |        6,109–7,212 |
| Hybrid |  1,438,042 |    58,931 | 2,654 |        8,245–9,154 |

Nested adds about 90% more spans but only about 5% more compressed HTML than
hybrid in this corpus. Its generated CSS is smaller after compression. This
does not establish a browser-performance advantage: layout, DOM memory, large
documents, virtual DOM updates, and real transfer patterns were not benchmarked.

## The browser caught a real prototype error

The initial nested theme selectors were not anchored at the code-block root.
A selector for a standalone JavaScript path also matched the suffix of an
embedded JavaScript path. This caused 86 style mismatches across Nord, Slack,
Synthwave, and Tokyo Night despite perfect path-identity checks.

Anchoring the entire path at `.fixture > ... > .token` removed all 86
mismatches. A focused regression test protects the anchor, and the full browser
matrix was rerun. This is why structural collision analysis alone is
insufficient. The holdout set is not claimed to be blind: the matrix was
inspected during this general rendering repair.

## What is not established

- The generated stylesheets project already-resolved reference styles onto
  **observed** paths. They prove representation fidelity, not the correctness
  of an arbitrary TextMate theme compiler. New paths need new generated rules.
- Direct styling with category/scope CSS does not need a theme file. Importing
  existing TextMate themes into CSS still needs a build-time resolution step.
- Raw scope information can remain complete without promising that every
  grammar uses the same semantic names. Grammar updates can change scopes.
- Token backgrounds, unsupported font properties, cross-browser behavior,
  sanitizers, decorations/transformers, Markdown adapters, and user usability
  were not validated by this experiment.
- The sample is small and intentionally includes adversarial cases. Neither
  18/20 nor 20/20 estimates the frequency of actual user requirements.

## Proposed direction

Use the nested representation as the basis for the next API design discussion.
Keep general token categories easy to select, and expose detailed scopes and
their ancestry through ordinary CSS. Avoid making generated path IDs necessary
for routine customization. Treat a compact hybrid mode as a separate option
only if measured DOM cost justifies the extra mechanism.

Before freezing a class contract, reduce redundant prefixes, verify a readable
stylesheet on complete application examples, check another browser engine,
exercise Markdown sanitizers and adapters, and have an independent reviewer
complete styling tasks from documentation. Keep this as an optional output
mode alongside the existing Shiki-compatible theme renderer.

The saved [evidence snapshot](../../node/experiments/class-highlighting/evidence.json)
includes source hashes, fixture hashes, collision details, task selectors,
browser results, and reference versions. That snapshot describes the original
prototype before the runtime implementation.

## Optional runtime implementation

The repository now implements nested scopes behind `styleMode: "classes"` in
Node and `StyleMode::Classes` in Rust. Inline output remains the default. The
[class-output guide](../class-highlighting.md) defines the class contract and
the new `codeToHtmlWithCss` helper.

Existing TextMate themes are resolved by the current native theme engine.
The renderer extracts those resolved styles into deduplicated CSS classes with
zero selector specificity. It does not reinterpret TextMate selector precedence
as CSS precedence. The generated CSS covers rendered content; collect it from
every rendered block. Own CSS can instead select scope categories directly.
Multiple prepared themes switch through `data-ferriki-theme`, preserving the
highlighted DOM. New themes still need a render or build step.

The actual implementation passed **175,164 token/theme comparisons** across
the same 23 cases and 66 themes with **zero computed-style differences**.
All **20 CSS tasks passed**, with no missed targets or collateral changes.
The browser also verified unchanged source text, ordinary CSS overrides, and
preserved token elements during theme switching.

The mandatory Node gate now checks the class API, scope order and repetition,
Unicode and HTML escaping, line endings, transformers, decorations, grammar
continuation, disposal, and theme-selection options. Rust unit and public-API
tests cover raw boundary preservation, context-dependent theme colors, scope
nesting, CSS extraction, and escaping. The website includes a demo using actual
Ferriki-generated output; its theme selector and CSS override were checked at
desktop and mobile widths. The existing default-output gates also pass.

These are implementation checks, not evidence of 95% coverage of user work.
Cross-browser behavior, large-document performance, and third-party sanitizers
still need their own validation. A sanitizer must retain scope wrappers,
classes, and the theme-selection attribute.

Actual output sizes for all 23 fragments, with deduplicated CSS, are:

| Configuration             | HTML bytes | Gzip HTML | CSS bytes | Gzip CSS |
| ------------------------- | ---------: | --------: | --------: | -------: |
| Own CSS (`theme: "none"`) |  1,681,629 |    50,350 |       274 |      207 |
| Monokai                   |  1,681,698 |    55,295 |     2,548 |      867 |
| GitHub Light and Monokai  |  1,683,837 |    57,821 |    11,364 |    1,848 |

These configurations differ from the prototype's path-projection stylesheets
and diagnostic HTML. The prototype's approximately 5% comparison is not a
general overhead bound for this API. Preparing all 66 themes for the browser
matrix produces 82,149 bytes of gzip HTML and 93,265 bytes of gzip CSS; typical
integrations should prepare the themes they actually use.

The [runtime evidence snapshot](../../node/experiments/class-highlighting/production-evidence.json)
ties this result to source and fixture hashes. Reproduction commands are in
the [experiment README](../../node/experiments/class-highlighting/README.md#validate-the-runtime-implementation).
