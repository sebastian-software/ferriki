# Prism quality and profiling investigation

This report compares Prism 1.30.0 with Ferriki 0.13.0 and Shiki 4.4.3, records
concrete highlighting examples, and profiles representative workloads. It is
an investigation, not a change to the runtime or a universal engine ranking.
The current Ferriki and Shiki engines both use the pinned TextMate grammar
assets, so exact HTML parity between those two is a useful regression check;
it does not make either implementation a semantic TypeScript checker.

## Reproduction and provenance

The six committed examples in `fixtures/` cover TypeScript parameter and type
annotations, nested template interpolation, a multiline comment, TSX nesting,
HTML script/style embeddings, Astro frontmatter and markup, and Vue directives,
interpolation, and a nested style injection. `fixtures.json` is the fixture
manifest. `quality.json` retains raw Prism output and Ferriki inline/class plus
Shiki output, source-preservation checks, grammar scopes, package and grammar
identity, and checksums. Run the capture from `node/` with
`node scripts/capture-prism-quality.mjs` after preparing the native addon and
offline assets. The exact capture-time source is retained at
`harness/capture-prism-quality.measured.mjs`; its SHA-256 matches the
`harnessSha256` recorded in `quality.json`.

The captures pin Prism 1.30.0 and its component manifest; Shiki 4.4.3 at
`48cd2cc…`; vscode-textmate 9.3.2 at `25b68da…`; the
`shikijs/textmate-grammars-themes` grammar package 1.32.3; and TypeScript
5.9.3. Exact package hashes, Ferriki release asset hashes, loaded Prism
components, and generated grammar identities are in `quality.json`. The
TextMate source of truth is the pinned Shiki grammar package, not a manually
edited Ferriki mirror. TypeScript's syntax expectations can be checked against
the [TypeScript functions handbook](https://www.typescriptlang.org/docs/handbook/2/functions.html);
the Vue case follows the documented [`v-for` syntax](https://vuejs.org/guide/essentials/list).
Prism documents its component grammar model in
[Extending Prism](https://prismjs.com/extending.html), while VS Code explains
[TextMate syntax highlighting](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)
and its separate [semantic-token layer](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide).

### Correctness findings

The following classifications describe the captured syntax and output, not
which engine is correct by fiat. A disagreement with Prism or TextMate alone
does not establish correctness.

| Case              | Observation                                                                                                                                                                                                                                                                                      | Classification                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parameters.ts`   | The TypeScript parser accepts `function greet(name: string): string { return name; }`. Prism leaves the parameter binding and its later read without the variable classifications Ferriki's grammar emits (`variable.parameter.ts` and `variable.other.readwrite.ts`). Both preserve the source. | **Missing identifier classification on valid TypeScript**, not a syntax error. This is a concrete lexical distinction in the fixture, not a claim that TextMate output is semantic analysis.                                 |
| `templates.ts`    | Both engines retain nested template interpolation and multiline comment state. Some nested token boundaries differ.                                                                                                                                                                              | **Scope-granularity difference** where source and syntactic regions remain intact; no demonstrated syntax error in this case.                                                                                                |
| `nested.tsx`      | Both engines handle JSX nested inside TypeScript expressions; emitted scopes and wrappers differ.                                                                                                                                                                                                | **Scope/presentation difference**, not a demonstrated token loss.                                                                                                                                                            |
| `embedded.html`   | Prism emits its component-level markup, CSS, and JavaScript spans. Ferriki and Shiki use TextMate scopes and a `<pre><code>` wrapper. Source is preserved.                                                                                                                                       | **Output-model and wrapper difference.** The markup is not byte-comparable as a correctness oracle.                                                                                                                          |
| `component.astro` | The pinned Prism 1.30.0 component manifest has no Astro grammar. Ferriki and Shiki highlight the fixture and preserve its source.                                                                                                                                                                | **Unsupported Prism case**, not an empty or failed Prism result.                                                                                                                                                             |
| `injection.vue`   | Prism has no Vue component. In the pinned TextMate grammar, the `v-for` value and mustache interpolation do not gain embedded JavaScript scopes, while `<style lang="scss">` routes to `source.css.scss`.                                                                                        | **Unsupported by Prism; inherited Vue grammar boundary in Ferriki/Shiki.** The captured gap is in the pinned upstream grammar and is not evidence of a Ferriki-only regression. Exact scopes are retained in `quality.json`. |

Prism also has no Svelte or MDX component in the pinned manifest. The curated
timing corpus marks Astro, Svelte, Vue, and MDX unsupported for Prism; no
fallback grammar is substituted. This report does not equate Prism's lack of a
TextMate scope model with a correctness defect.

## Repeated curated timing results

The data files `timings/curated-run-01.json` and `timings/curated-run-02.json`
contain the full raw samples, source identities, validation results, and build
receipts. Both runs used the same clean common-base runtime commit
`6521b1be906e5a2711cddb15164e3ed2bd4a9af8`, Ferriki 0.13.0 / Ferroni 2.1.0,
release addon SHA-256 `3f10a1942a185db64423013dc034165deba6bea02776c332117e5c987d7c96ae`,
and release asset manifest SHA-256
`30ca207f07ee8616369ffb8e5c6456195abca74d56de6a106a87cf99cd83debf`. The
machine was an Apple M1 Ultra running Darwin 27.0.0 and Node v24.21.0. Each
case is a warmed end-to-end HTML render, with setup and oracle validation
outside the timed loop. Engine order rotates within each case; formats run
sequentially in fresh workers. `large` repeats the exact source fixture 16
times and is synthetic traffic. Results are medians in milliseconds, shown as
run 01 / run 02. The TOML example reached the 1,000-sample cap in both runs;
the stored JSON reports give the actual sample counts and elapsed durations.
Per-engine import/setup durations are also retained as `importAndSetupMs`, but
excluded from the per-document timing cells.

These are descriptive timings for different grammar and HTML output models.
They do not establish a universal ranking or equal highlighting quality.
Prism's four unsupported cells remain explicit. Ferriki and Shiki source
preservation and exact HTML parity passed for all 40 cases per run; Prism
source preservation passed for its 32 supported cases per run.

| Language   | Example bytes |       Ferriki |         Prism |    Shiki WASM |      Shiki JS | Large bytes |         Ferriki |         Prism |      Shiki WASM |          Shiki JS |
| ---------- | ------------: | ------------: | ------------: | ------------: | ------------: | ----------: | --------------: | ------------: | --------------: | ----------------: |
| TypeScript |         1,203 | 0.684 / 0.671 | 0.292 / 0.283 | 2.908 / 2.844 | 8.081 / 7.924 |      19,248 |   7.687 / 7.682 | 3.428 / 3.424 | 42.330 / 42.074 | 123.680 / 122.532 |
| TSX        |         1,568 | 0.733 / 0.731 | 0.443 / 0.445 | 2.643 / 2.659 | 6.303 / 6.294 |      25,088 |   8.724 / 8.756 | 5.658 / 5.607 | 39.698 / 39.160 |   97.866 / 97.036 |
| Rust       |           965 | 0.316 / 0.309 | 0.139 / 0.139 | 1.778 / 1.774 | 1.269 / 1.266 |      15,440 |   4.288 / 4.230 | 1.676 / 1.683 | 27.086 / 27.278 |   19.314 / 19.429 |
| CSS        |         1,076 | 0.530 / 0.516 | 0.111 / 0.107 | 1.888 / 1.852 | 0.700 / 0.676 |      17,216 |   6.344 / 6.273 | 1.450 / 1.455 | 28.124 / 28.185 |     9.624 / 9.867 |
| HTML       |         1,397 | 0.875 / 0.862 | 0.305 / 0.298 | 2.346 / 2.311 | 3.712 / 3.650 |      22,352 |  10.011 / 9.911 | 3.542 / 3.528 | 34.052 / 33.925 |   54.313 / 54.161 |
| C++        |           937 | 0.803 / 0.818 | 0.151 / 0.156 | 3.696 / 3.708 | 6.228 / 6.276 |      14,992 |   8.120 / 8.017 | 1.698 / 1.672 | 55.076 / 53.216 |   95.361 / 93.640 |
| Swift      |           969 | 0.411 / 0.406 | 0.117 / 0.116 | 2.072 / 2.059 | 1.441 / 1.429 |      15,504 |   4.932 / 4.855 | 1.456 / 1.445 | 30.784 / 30.612 |   21.123 / 21.189 |
| Java       |         1,116 | 0.338 / 0.329 | 0.142 / 0.140 | 1.528 / 1.506 | 1.313 / 1.290 |      17,856 |   4.387 / 4.416 | 1.821 / 1.858 | 23.132 / 23.317 |   19.689 / 20.172 |
| Markdown   |         1,019 | 0.552 / 0.551 | 0.265 / 0.265 | 1.573 / 1.578 | 3.045 / 3.012 |      16,304 |   5.296 / 5.313 | 3.087 / 3.101 | 21.584 / 21.121 |   42.924 / 42.781 |
| TOML       |           606 | 0.133 / 0.136 | 0.045 / 0.045 | 0.263 / 0.265 | 0.195 / 0.196 |       9,696 |   1.881 / 1.867 | 0.680 / 0.687 |   3.845 / 3.805 |     2.824 / 2.817 |
| YAML       |           787 | 0.237 / 0.242 | 0.065 / 0.066 | 0.586 / 0.592 | 0.470 / 0.473 |      12,592 |   3.398 / 3.454 | 0.895 / 0.922 |   8.539 / 8.697 |     7.000 / 7.119 |
| JSON       |           761 | 0.226 / 0.236 | 0.074 / 0.076 | 0.433 / 0.437 | 0.382 / 0.379 |      12,176 |   3.377 / 3.516 | 1.135 / 1.162 |   6.600 / 6.691 |     5.866 / 5.949 |
| Astro      |         1,081 | 1.409 / 1.430 |   unsupported | 3.726 / 3.743 | 5.291 / 5.387 |      17,296 | 15.193 / 15.555 |   unsupported | 45.406 / 47.044 |   72.977 / 74.922 |
| Svelte     |         1,062 | 1.295 / 1.330 |   unsupported | 4.000 / 3.993 | 6.845 / 7.005 |      16,992 | 15.986 / 16.452 |   unsupported | 59.836 / 60.083 | 105.774 / 106.833 |
| Ruby       |           856 | 0.344 / 0.380 | 0.154 / 0.160 | 2.474 / 2.570 | 2.100 / 2.190 |      13,696 |   4.310 / 4.355 | 1.804 / 1.841 | 37.482 / 38.371 |   31.482 / 32.442 |
| Python     |         1,364 | 0.479 / 0.505 | 0.171 / 0.174 | 2.312 / 2.343 | 1.763 / 1.754 |      21,824 |   5.887 / 5.986 | 2.131 / 2.172 | 35.226 / 35.215 |   26.264 / 26.438 |
| Vue        |         1,310 | 0.737 / 0.766 |   unsupported | 2.889 / 2.996 | 4.194 / 4.341 |      20,960 |   8.362 / 8.482 |   unsupported | 43.674 / 44.698 |   64.351 / 66.031 |
| MDX        |         1,075 | 0.680 / 0.700 |   unsupported | 2.428 / 2.502 | 5.512 / 5.689 |      17,200 |   7.185 / 8.217 |   unsupported | 35.141 / 41.936 |  83.970 / 108.733 |
| SCSS       |           856 | 0.494 / 0.625 | 0.206 / 0.228 | 3.828 / 4.214 | 0.887 / 0.995 |      13,696 |   5.085 / 5.310 | 2.774 / 2.863 | 58.350 / 62.801 |   12.428 / 13.098 |
| Bash       |         1,011 | 0.428 / 0.529 | 0.156 / 0.180 | 1.279 / 1.423 | 0.954 / 1.071 |      16,176 |   5.711 / 6.399 | 1.918 / 2.063 | 18.795 / 23.878 |   13.808 / 23.292 |

The TOML example hit the same 1,000-round maximum for each engine in both
runs, and is not an estimate with the same stopping behavior as other cells.
The full raw report is the authority for each cell's sample count and actual
elapsed window.

## Inline versus class-based output

`timings/output-modes.json` contains one diagnostic matrix over TypeScript,
TSX, HTML, C++, JSON, and Astro at example and large sizes. It interleaves
inline and class-based calls with 30 paired samples per mode. This is a single
capture, not a repeated performance estimate. Both modes ran the same warmed
Ferriki highlighter and source inputs. The class mode additionally constructs
full TextMate scope classes, ancestor wrappers, and extracted CSS with hashed
style rules, so the columns include materially different rendering work and
output contracts.

| Language / size    | Inline HTML bytes | Class HTML + CSS bytes | Inline median ms | Class median ms | Class / inline |
| ------------------ | ----------------: | ---------------------: | ---------------: | --------------: | -------------: |
| TypeScript example |             9,727 |                301,384 |            0.684 |          11.023 |          16.1× |
| TypeScript large   |           153,592 |              4,800,784 |            7.653 |         160.542 |          21.0× |
| TSX example        |            12,390 |                386,307 |            0.711 |          14.207 |          20.0× |
| TSX large          |           196,200 |              6,157,137 |            8.820 |         233.049 |          26.4× |
| HTML example       |            11,838 |                359,932 |            0.845 |          10.685 |          12.6× |
| HTML large         |           187,368 |              5,732,722 |           10.581 |         178.668 |          16.9× |
| C++ example        |             7,548 |                328,536 |            0.867 |          10.338 |          11.9× |
| C++ large          |           118,728 |              5,235,216 |            9.072 |         162.417 |          17.9× |
| JSON example       |             6,509 |                314,493 |            0.300 |          11.599 |          38.7× |
| JSON large         |           102,104 |              5,020,188 |            3.703 |         187.358 |          50.6× |
| Astro example      |            10,093 |                312,733 |            1.463 |          11.102 |           7.6× |
| Astro large        |           131,098 |              4,225,798 |           16.593 |         148.976 |           9.0× |

These raw byte totals do not measure compression, network transfer, DOM size
after parsing, or browser rendering cost. The output expansion is consistent
with the extra scope-prefix class list, nested wrappers, and CSS extraction;
it is not evidence that one output contract should be removed. Any follow-up
must preserve full scope visibility and CSS override semantics.

The class harness had two pre-sampling failures: an invalid shell redirection
path prevented the first Node process from starting, then a manifest identity
variable reference error stopped the second before sampling. Both attempts
produced no timed samples. The corrected harness passed syntax and identity
checks, then produced the retained single 12-row matrix. See
`timings/attempt-notes.md` and the exact measured pre-format harness snapshot
at `timings/harness/bench-prism-output-modes.measured.mjs`. The harness used
30 samples per mode with a 100 ms target and a minimum of 30 rounds; actual
mode windows ranged from 366 ms to 7,282 ms as rendering time varied. Those
single-capture durations are retained in the raw report, not treated as equal
windows.

## Profiles and optimization candidates

The diagnostic set has 17 successful serial captures across C++, TypeScript,
TSX, JSON, HTML, and Astro: five Prism JavaScript CPU profiles (Prism has no
Astro grammar), six Ferriki facade JavaScript profiles, and six native
Ferriki-boundary macOS `sample` profiles. All source-preservation and applicable
Ferriki/Shiki HTML parity checks passed. The profiles use a separate
symbol-bearing diagnostic addon (`52a9f7b044af400bd27c67e41011b7038471470db1cdbace1532e78ff82bf190`)
built with line tables and no stripping. It is not the release addon used for
timings. The sample workload is the large curated fixture (16 copies); setup
and validation precede capture. Inspector captures cover an 8-second render
loop; native samples attach for 6 seconds. Raw profiles, capture index,
attempt notes, source snapshots, and machine context are in
`profiles/current/`. Published JSON, logs, and text artifacts are
path-redacted; `path-redactions.json` maps captured and published SHA-256
values. Pre-normalization originals remain only in the locally ignored
`private-originals/` directory. Sample arrays, timing values, native symbols,
and binary/fixture identities are unchanged.

The Node Inspector and macOS `sample` reports are diagnostic samples, not
standalone timing measurements. The following JavaScript percentages use
sampled `timeDeltas` assigned to a frame (exclusive self time); inclusive
ancestor counts overlap and must not be summed. Ferriki's Inspector profile
attributes most samples to the synchronous native callback frame, which is
opaque to JavaScript and is not a Rust function breakdown. These percentages
are profile attribution, not runtime latency shares.

| Language   | Prism top self-sampled JavaScript frames                   | Ferriki top self-sampled Inspector frame |
| ---------- | ---------------------------------------------------------- | ---------------------------------------- |
| C++        | `matchPattern` 31.9%; `encode` 26.5%                       | native `FerrikiHighlighter` 97.1%        |
| TypeScript | `matchPattern` 49.4%; `encode` 18.9%                       | native `FerrikiHighlighter` 96.4%        |
| TSX        | `matchPattern` 36.3%; `encode` 13.3%; `matchGrammar` 12.7% | native `FerrikiHighlighter` 95.6%        |
| HTML       | `matchPattern` 22.2%; `encode` 22.2%; `stringify` 18.4%    | native `FerrikiHighlighter` 96.4%        |
| JSON       | `encode` 33.6%; `stringify` 19.6%; `matchPattern` 19.2%    | native `createHighlighter` 94.4%         |
| Astro      | Prism unsupported                                          | native `FerrikiHighlighter` 97.4%        |

Prism's profiles sampled grammar matching plus HTML encoding/stringification;
the mix differs by language. The Ferriki Inspector profiles are dominated by
the native callback boundary, so their detailed attribution comes from the
separate line-table `sample` outputs. The table below is regenerated by
`pnpm run summarize:prism-profiles` and retained in
`profiles/current/analysis.json`. For each family, the script counts the union
of matching subtrees in the main-thread call graph, so a nested stack branch
counts once within that family. Each percentage uses the main-thread sample
count as its denominator. Families overlap and their percentages must not be
added. These are inclusive stack weights, not exclusive CPU shares.

| Language   | Main-thread samples | TextMate tokenization | Regex scanning | Captures/scopes | Theme matching | Token prep/style | HTML rendering | Allocator frames |
| ---------- | ------------------: | --------------------: | -------------: | --------------: | -------------: | ---------------: | -------------: | ---------------: |
| C++        |               4,023 |         3,348 (83.2%) |  1,960 (48.7%) |   1,311 (32.6%) |     353 (8.8%) |       148 (3.7%) |     358 (8.9%) |      721 (17.9%) |
| TypeScript |               3,446 |         2,729 (79.2%) |  1,394 (40.5%) |     682 (19.8%) |    346 (10.0%) |       174 (5.0%) |    368 (10.7%) |      734 (21.3%) |
| TSX        |               3,801 |         2,941 (77.4%) |  1,434 (37.7%) |     691 (18.2%) |     345 (9.1%) |       213 (5.6%) |    477 (12.5%) |      816 (21.5%) |
| HTML       |               3,713 |         3,053 (82.2%) |  1,327 (35.7%) |     592 (15.9%) |     258 (6.9%) |       151 (4.1%) |     344 (9.3%) |      862 (23.2%) |
| JSON       |               3,773 |         2,614 (69.3%) |    524 (13.9%) |   1,052 (27.9%) |    505 (13.4%) |       282 (7.5%) |    642 (17.0%) |    1,106 (29.3%) |
| Astro      |               3,819 |         3,471 (90.9%) |  1,355 (35.5%) |     513 (13.4%) |     211 (5.5%) |        88 (2.3%) |     188 (4.9%) |    1,045 (27.4%) |

The tokenization family matches `Grammar::tokenize_line2`, `Grammar::tokenize`,
and `tokenize_string`; regex scanning matches the `RuleScanner` and Ferroni
scanner/regset/DFA paths; captures/scopes matches capture and scope production
frames; theme matching matches `Theme::match_scope` and
`ScopeAttributesProvider::theme_match`; token prep/style matches
`prepare_tokens` and `token_style`; HTML rendering matches `render_html`; and
allocator frames match `RawVecInner::finish_grow` and macOS allocator frames.
These families overlap and are not a breakdown of one additive total. The
native stack includes `HighlighterCore::tokenize`, TextMate grammar traversal,
theme resolution, token preparation, and Ferroni's regex scanner. C++,
TypeScript, TSX, HTML, and Astro show a substantial sampled regex path. JSON
assigns less sampled weight to regex scanning and more to capture/scope,
theme matching, rendering, and allocator frames. The report does not turn
these sampled paths into exact phase times or allocation counts.

Iteration counts and source/HTML byte sizes are workload and output-volume
proxies, not exact allocation counts or allocated bytes. Compare stacks only
within this capture setup. The capture window ran from
`2026-10-10T12:03:10Z` to `2026-10-10T12:05:40Z`; machine and OS details plus
all raw capture checksums are retained in `profiles/current/index.json` and
`profiles/window-context.txt`.

The capture-time profile harness and worker source are archived under
`profiles/current/harness/` with the exact hashes listed in the index. The
working scripts later received lint-only import-order and explicit `Buffer`
import fixes; their current hashes are recorded separately from the capture
hashes in that index.

The following are bounded hypotheses for a later controlled experiment, not
implemented changes or findings that a specific change will be faster:

1. **Class output:** memoize repeated scope-prefix expansion and style hashing
   within one render. Keep the full scope class set, wrapper nesting, and CSS
   override behavior. Validate identical HTML/CSS and measure all six paired
   fixtures before retaining any change.
2. **Native scan path:** in Ferroni 2.1.0's
   `regset_search_body_position_lead` → `search_fallback_entries` →
   `attempt_fallback_entry` path, test whether repeated fallback candidate
   attempts at the same subject/position survive the existing entry gates and
   fallback memo. Start with the large C++ and TSX fixtures, where the
   main-thread tree assigns 48.7% and 37.7% to the regex-scanning family, and
   JSON as a lower-regex control (13.9%). Add narrowly scoped counters in an
   experimental build; only prototype deduplication if they show equivalent
   work repeating. Preserve callout and position-sensitive fallback behavior,
   then compare ordinary release builds with rotating repeated runs and exact
   HTML/parity gates. The investigation makes no Ferroni or runtime change.
3. **Prism syntax gap:** if Prism compatibility is desired, fix or upstream the
   TypeScript parameter classification as a separate grammar-quality change;
   this investigation does not patch Prism or Ferriki grammar mirrors.
4. **Grammar boundaries:** evaluate Vue interpolation/attribute injection
   gaps against the pinned upstream grammar's documented scope source before
   proposing an upstream or downstream grammar change.

Suggested follow-up issue text (draft only):

> Profile class-mode rendering on representative TypeScript, TSX, HTML, C++,
> JSON, and Astro inputs. Prototype per-render memoization for repeated scope
> class expansion and style hashing while preserving full TextMate scope
> classes, ancestor wrappers, HTML, CSS override behavior, and existing
> inline/class API contracts. Compare ordinary release builds with repeated
> rotating runs and assert exact HTML/CSS equality; retain only a measured
> improvement. Separately, instrument the Ferroni 2.1.0
> `regset_search_body_position_lead` → `search_fallback_entries` →
> `attempt_fallback_entry` path on large C++ and TSX inputs and JSON as a
> control. Determine whether equivalent fallback attempts repeat despite the
> current gate/memo behavior before prototyping deduplication. Keep callout and
> position-sensitive behavior and all grammar assets unchanged; compare
> ordinary release builds with repeated runs and exact HTML parity.

## Reproducible performance commands

From `node/`, after installing comparator packages and building the ordinary
release addon:

```sh
pnpm run check:bench-curated
pnpm run bench:curated --write /tmp/curated-report.json
node scripts/bench-prism-output-modes.mjs --write /tmp/prism-output-modes.json
node scripts/capture-prism-profiles.mjs --seconds 8 --sample-seconds 6
pnpm run summarize:prism-profiles
```

The profile capture command requires macOS `sample`; the JavaScript profiles
use Node Inspector. Build the symbol-bearing diagnostic addon separately from
ordinary timings, retain its exact receipt/hash, and never cite its runs as
release performance. Keep workloads sequential: builds and CPU profiling
must not overlap timed captures.
