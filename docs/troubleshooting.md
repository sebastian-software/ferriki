# Ferriki troubleshooting

## `No native binary for <platform>-<arch>`

This is the actual loader error when no candidate can be loaded. It lists the
paths tried under the package directory. Check, in order:

1. the matching optional package (`@ferriki/<platform>`) is installed; the
   main package itself ships no native addon;
2. the package was installed with optional dependencies and lifecycle scripts
   allowed by your deployment policy;
3. the target is in the documented CI support matrix (on Linux the loader
   detects glibc or musl and picks the matching sidecar);
4. the Node ABI and native binary were built for the same target.

Do not set a backend switch or install a JavaScript/WASM fallback: Ferriki has
one native runtime and should fail clearly when its target is unsupported.

On an unsupported target, Ferriki reports the complete supported matrix and
the detected platform/architecture/libc.

## `Language \`...\` not found`

Load the language before synchronous rendering, or use the async factory with
the bundled loader:

```js
import { bundledLanguages, createHighlighter } from '@ferriki/core'

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

The gate packs `node/ferriki` and the host's platform package, installs both
tarballs into a temporary consumer with lifecycle scripts disabled, and imports
only the installed `@ferriki/core` package. A failure usually means a missing `files` entry, asset, declaration,
or platform sidecar. Inspect `npm pack --dry-run` from `node/ferriki`.

## `Ferriki could not download assets` or `… is not cached`

Standard grammars and themes are not bundled; they are downloaded on first use
from `https://assets.ferriki.dev/<release-commit>/assets/shiki/…`, verified by
SHA-256 and cached ([ADR 0013](../adr/0013-cdn-loaded-standard-assets.md)).

- **`Ferriki could not download assets: … HTTP 404` or a connection error**:
  the mirror is unreachable or does not serve that release. Check network
  access, a proxy (`HTTPS_PROXY` is honored), or `FERRIKI_ASSETS_BASE_URL`.
  Downloads are not retried.
- **`… did not match its release-pinned SHA-256`**: the mirror served
  different bytes. Nothing was cached; fix the mirror.
- **`… is not cached … Load it through the asynchronous createHighlighter,
  loadLanguage or loadTheme first`**: a synchronous path met a language or theme
  that was never loaded. Load it asynchronously once, or pre-populate the cache.
- **`… remote assets are turned off`**: `remote: false` or
  `FERRIKI_ASSETS_REMOTE=0` is set and the cache lacks the payload.

TLS verification uses the operating system's trust store, so certificate
authorities installed for a corporate proxy work without extra settings.

## Offline and air-gapped use

There is no offline package; use one of these instead:

- **Reuse a populated cache.** Run the build once with network access, then
  keep the cache directory (`node_modules/.cache/ferriki` by default, or
  `FERRIKI_CACHE_DIR`) as a CI cache or container layer, and set
  `FERRIKI_ASSETS_REMOTE=0` for the offline runs. The cache holds one file per
  SHA-256 digest; entries never change and are reused across releases.
- **Run a mirror.** Serve a copy of the repository's `assets/shiki/` at the
  release commit below `<release-commit>/assets/shiki/` and set
  `FERRIKI_ASSETS_BASE_URL` (or the `baseUrl` asset option) to its root. The
  commit is recorded in `node_modules/@ferriki/core/assets/shiki/release-manifest.json`.

Privacy: a default install contacts `assets.ferriki.dev` the first time a
language or theme is used, sending an ordinary HTTPS request for that file.
Set `FERRIKI_ASSETS_REMOTE=0`, or use a mirror, to avoid it.
