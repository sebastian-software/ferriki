# Class-highlighting experiment

This is a reproducible research prototype, outside Ferriki's public API. It
compares three representations of the same native raw TextMate scope tokens:

- `flat`: readable prefix classes for all scopes, ancestor context, and the
  innermost scope, on one token span;
- `nested`: the same readable token classes plus nested scope spans, sharing
  common ancestors between adjacent tokens;
- `hybrid`: flat readable classes plus a deterministic full-path class and
  an external path dictionary.

The three-model comparison remains a research prototype. Its class names and
serialization describe that experiment, rather than the public class contract.
The nested representation now also has an optional runtime implementation;
see [the class-output guide](../../../docs/class-highlighting.md).

## Reproduce

Use the installed workspace dependencies and the existing native build. From
the repository root, prepare the reference distributions and native addon with
the repository's required gate when they are missing or stale:

```sh
pnpm -C node run test:ferriki-compat:core
node node/experiments/class-highlighting/run.mjs
pnpm -C node exec vitest run experiments/class-highlighting/models.test.mjs
node node/experiments/class-highlighting/serve.mjs
```

Open the loopback URL printed by the server. Click **Run browser verification**.
The page compares computed foreground color, italic, bold, underline, and
strikethrough for every raw token, theme, and model. It also checks handwritten
CSS tasks for missed targets and unintended changes. Both light and dark
palettes in `custom-theme.css` are tested without a TextMate theme file. The
gallery lets a reviewer switch themes, cases, and models and inspect the DOM.

After the browser finishes, save a reviewable evidence snapshot:

```sh
node node/experiments/class-highlighting/export-evidence.mjs
```

The exporter verifies that the browser used the exact generated corpus and
records source hashes, fixture hashes, versions, analysis, and browser results.
Refreshing `evidence.json` is an explicit experiment-baseline update, not a
routine formatting change. The server only serves the experiment's files and
writes evidence under `node/.generated/class-highlighting`; stop it with Ctrl-C.

## What the checks establish

`run.mjs` compares native `ferriki-textmate::Grammar::tokenize_line` output
against the installed Shiki TextMate implementation. It fails on a raw-scope
or token-boundary mismatch. Theme-independent scope boundaries are preserved;
the existing color-token projection is not used to obtain scope paths.

The native Ferriki facade's themed output is independently compared with
Shiki's foreground and font-style output per UTF-16 code unit. The comparison
does not require equal token merging or HTML segmentation.

Theme CSS is a **projection of the reference styles onto observed scope
paths**. This tests whether each output representation can carry the exact
result and be overridden using ordinary CSS. It is not an implementation of a
general TextMate-theme-to-CSS-selector compiler. New content with new paths
requires extending the generated stylesheet. The handwritten custom palette
does not have this restriction for categories its selectors cover.

The flat representation intentionally keeps the first style when multiple
paths have identical classes. Its conflicts must remain visible; the experiment
does not secretly add path IDs or use inline colors to make it pass.

Generated theme rules use `:where()` to keep selector specificity low.
Handwritten task rules override them without `!important`. Nested generated
selectors anchor the complete path at the code-block root to prevent a
standalone-language path from matching the suffix of an embedded-language path.

## Corpus and interpretation

The corpus has authored probes and excerpts from the existing Shiki comparison
corpus: 14 real languages plus a synthetic context grammar. Real source excerpts
are limited to their first 24 lines; they are not whole-project coverage.
The 65 shipped themes are supplemented by one synthetic context theme.

There are 20 named tasks, with a 14/6 development/holdout split, and a 14/9
fixture split. Their targets are defined from raw scope paths separately from
CSS selectors. Every task must have actual targets. Language-specific labels
use language-specific selectors. The regex fixture includes both character
classes and an escaped literal slash, so the escape task is exercised.

This is a curated technical task catalog, not a blinded usability study or a
statistical sample of user activity. Grammar scope naming defines the target
semantics; it is not an independent language AST. Development and holdout
results are reported separately, but the whole matrix was inspected while
repairing a general selector-anchoring bug. No population-level 95% claim is
supported.

Token backgrounds, arbitrary CSS properties, transformer/decorations behavior,
cross-browser behavior, sanitizers, Markdown adapters, and stable grammar-update
semantics are not established here. The byte counts include diagnostic token
attributes and an intentionally exhaustive set of prefix classes; no production
payload or browser-performance claim should be inferred.

See [the findings](../../../docs/experiments/class-highlighting.md) and
[`evidence.json`](evidence.json) for the recorded run.

## Validate the runtime implementation

After preparing the reference corpus with `run.mjs`, generate actual Ferriki
class output and measure three practical theme configurations:

```sh
node node/experiments/class-highlighting/production.mjs
node node/experiments/class-highlighting/production-sizes.mjs
node node/experiments/class-highlighting/production-serve.mjs
```

Open the printed loopback URL and click **Verify all themes**. This compares
the browser's computed styles with the frozen independent reference for all
66 themes, then exercises the 20 CSS tasks. Theme switching must preserve the
source and token elements. Save the matching result with:

```sh
node node/experiments/class-highlighting/export-production-evidence.mjs
```

[`production-evidence.json`](production-evidence.json) records the runtime
source hashes, corpus hashes, browser results, and sizes. The all-theme matrix
intentionally prepares 66 palettes; its transfer size is distinct from the
single-theme and dual-theme measurements. Both snapshots describe a curated
corpus in one browser engine, without a population-level coverage claim.
