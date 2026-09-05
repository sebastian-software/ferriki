# Ferriki troubleshooting

## `No native binary for <platform>-<arch>`

This is the actual loader error when no candidate can be loaded. It lists the
paths tried under the package directory. Check, in order:

1. the installed package contains `dist/ferriki.<platform>-<arch>.node` or
   `dist/ferriki.node`;
2. the package was installed with optional dependencies and lifecycle scripts
   allowed by your deployment policy;
3. the target is in the documented CI support matrix;
4. the Node ABI and native binary were built for the same target.

Do not set a backend switch or install a JavaScript/WASM fallback: Ferriki has
one native runtime and should fail clearly when its target is unsupported.

## `Language \`...\` not found`

Load the language before synchronous rendering, or use the async factory with
the bundled loader:

```js
import { bundledLanguages, createHighlighter } from 'ferriki'

const highlighter = await createHighlighter({
  langs: [bundledLanguages.typescript],
  themes: ['nord'],
})
```

Check `bundledLanguagesAlias` when a file extension or common alias is used.
Custom grammar registrations must contain a `name`, `scopeName`, and valid
TextMate patterns.

## `Theme \`...\` not found`

Use a key from `bundledThemes` or load a `ThemeRegistration` with a unique
`name`. The special theme `none` is supported for unstyled output; Ferriki
uses its normal renderer backing internally and returns no theme colors.

## `Shiki instance has been disposed`

The highlighter is no longer usable after `dispose()` or a `using` scope ends.
Create a new instance instead of retaining a disposed reference. This also
applies to `loadLanguage*` and `loadTheme*` calls.

## Long lines or tokenizer time limits

The default per-line tokenization budget is 500 ms. Set
`tokenizeTimeLimit: 0` only for trusted workloads where an unlimited line is
acceptable. `tokenizeMaxLineLength` defaults to unlimited (`0`); when set, a
line at or above the limit is returned as one unstyled token so callers can
identify the degradation instead of receiving misleading syntax colors.

Ferriki's public highlighter is synchronous after creation. Calls on one
instance are serialized; use one instance per worker for parallel workloads.

## ANSI input is rejected

Ferriki does not parse terminal control sequences. If `lang: 'ansi'` is passed
with ESC bytes, `ShikiError` is intentional. Parse ANSI into styled segments or
strip the control sequences before calling Ferriki.

## Output is escaped incorrectly

Ferriki escapes source text and serializes its own HAST. It does not sanitize
arbitrary HAST nodes or HTML returned by a transformer because transformers
are outside the core API. Keep untrusted code and fence metadata on the
escaped side of the Ferromark/Ardo adapter boundary.

## Packed package works in the checkout but not after install

Run the clean-consumer gate from the Node workspace:

```sh
pnpm run build:native
pnpm run check:docs
```

The gate packs `node/ferriki`, installs that tarball into a temporary consumer
with lifecycle scripts disabled, and imports only the installed `ferriki`
package. A failure usually means a missing `files` entry, asset, declaration,
or platform sidecar. Inspect `npm pack --dry-run` from `node/ferriki`.
