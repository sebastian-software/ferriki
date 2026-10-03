# Migrating from Shiki to Ferriki

Ferriki follows the Shiki API shape but has a deliberately smaller native-only
runtime. This guide is for a Shiki **v4.4.3** consumer moving to the Ferriki
pre-1.0 package.

## Before changing code

1. Confirm that your deployment can install a Ferriki native binary.
2. Pin the Ferriki version in the same lockfile as Ferromark/Ardo.
3. Run the packed-package smoke test in CI; a repository checkout is not a
   valid substitute for an installed package.
4. Decide where each adapter runs. Transformers and decorations are supported
   by Ferriki's JavaScript facade; Markdown and framework adapters remain
   separate packages.

## Compatibility matrix

| Shiki surface | Ferriki status | Migration |
| --- | --- | --- |
| `codeToHtml` | Supported | Keep the call shape and use a Ferriki theme/language ID. HTML is the only public Node render output. |
| `codeToHast`, `codeToTokens`, `codeToTokensBase`, `codeToTokensWithThemes`, `hastToHtml` | Removed before 1.0 | Remove these imports and highlighter calls. Use `codeToHtml`/`codeToHtmlWithCss` and the HTML transformer callbacks; Rust consumers retain the published Rust token APIs. |
| Reusable highlighters and singleton | Supported | Keep the factory pattern and dispose long-lived instances explicitly. |
| Standard language/theme loaders and aliases | Supported | Use `bundledLanguages`, `bundledThemes`, and `bundledLanguagesAlias`. |
| Custom TextMate grammar/theme registrations | Supported | Pass validated JSON-shaped registrations to the factory or load methods. |
| Ordered `themes` map and `defaultColor: false` | Supported | Use for Ardo/Ferromark light/dark output. |
| HAST serialization | Removed before 1.0 | Use the HTML renderer and transformer hooks. There is no public standalone HAST tree or serializer. |
| `transformers` and `decorations` | Supported in the JavaScript facade | Hooks still receive Ferriki-typed token/HAST callback data while rendering HTML; the transformer context has no nested `codeToHast` or `codeToTokens` helpers. |
| Grammar-state continuation | Supported for HTML | Call `getLastGrammarState(code, options)` and pass its result to a later HTML call through `grammarState`; token/HAST-result overloads are removed. |
| Class-based HTML and generated CSS | Ferriki extension | Use `styleMode: 'classes'` or `codeToHtmlWithCss()`; inline styles remain the default. |
| Standard grammar/theme assets | Downloaded asynchronously | `createHighlighter`, async loads and one-shot calls fetch missing release-pinned payloads. The package contains catalog metadata, not payloads. |
| `rehype`, `markdown-it`, and other adapters | Separate packages | Keep Markdown integration in its adapter; Ferriki core does not include these packages. |
| Vite adapter | Separate optional package; not published with the current core release | The source is in [`node/vite`](../../node/vite/README.md). Check its release status before adding it to an npm install. |
| JavaScript/Oniguruma engine injection | Removed | Ferriki owns native matching; remove `engine` and engine factories. |
| `loadWasm`/`wasmBinary` | Removed | Install the platform package/binary instead. |
| `lang: 'ansi'` with escape sequences | Rejected | Strip or parse terminal control sequences first. |
| Browser runtime | Unsupported | Run Ferriki in Node or use a separate browser highlighter. |

The exact baseline and exclusions are machine-checked from the pinned Shiki
mirror. “Shiki-compatible” means a tested subset, not that every Shiki package
is a Ferriki feature. The [published `@ferriki/core@0.8.3` and Shiki 4.4.3
migration sample](https://github.com/sebastian-software/ferriki/issues/38#issuecomment-5968270993)
is historical evidence for the earlier structured-output boundary: its
JSON-serialized HAST matched, while raw objects could differ where Shiki
included properties such as `data: undefined`; multi-theme token output also
had Ferriki-specific `htmlStyle` and `variants` shapes. These methods are
removed from the pre-1.0 Node contract, so that comparison does not describe
the current API. Use `codeToHtml` or `codeToHtmlWithCss` for rendered output;
Rust consumers can use the Rust token APIs.

The asynchronous factory and loading methods download standard grammar and
theme payloads by default, then verify and cache them. Highlighting on a loaded
highlighter is synchronous. Prepopulate the cache or configure the asset mirror
and `FERRIKI_ASSETS_REMOTE` for offline builds.

## Typical replacement

```diff
- import { createHighlighter } from 'shiki'
+ import { createHighlighter } from '@ferriki/core'

  const highlighter = await createHighlighter({
    langs: ['typescript'],
    themes: ['nord'],
  })

  const html = highlighter.codeToHtml(source, {
    lang: 'typescript',
    theme: 'nord',
  })
```

For one-off calls, `codeToHtml(source, options)` uses a shared singleton and
returns a Promise. For repeated rendering, prefer an explicitly configured
highlighter so language/theme loading and disposal are visible.

## Error handling

Ferriki validates options before the native call. Catch `ShikiError` for
unsupported languages/themes, circular aliases, disposed highlighters, ANSI
input, and other user-actionable failures. A missing native binary starts with
`[ferriki] No native binary for` and includes the platform and every attempted
path; fix installation/target support rather than falling back to a JS engine.

Handle unknown languages at the document integration boundary. If the
consumer chooses a plaintext fallback, it must escape the source and any fence
metadata before writing HTML and should report the fallback to the caller.

## Downstream adapter boundaries

Prepare a Ferriki highlighter asynchronously before handing it to a rendering
callback. Calls on that loaded highlighter are synchronous. The repository's
[`docs/examples/ferromark-ardo.mjs`](../examples/ferromark-ardo.mjs) shows this
shape and the escaping boundary; it is a Ferriki API fixture, not a released
Ferromark or Ardo Node integration. Those packages own their own compatibility
and release status. For the current Rust hook contract, see
[`docs/rust-api.md`](../rust-api.md).

The executable contract in `node/scripts/check-ferromark-ardo-contract.mjs`
asserts the Ferriki API behavior used by the fixture. It does not install or
test published Ferromark or Ardo packages. The fixture covers:

- `codeToHtml(code, { lang, meta })` on a prepared highlighter emits aligned
  light/dark Shiki output with `.line` elements;
- `meta.__raw` remains opaque to Ferriki, so Ardo can safely parse title/label
  metadata and attach its own figure/line attributes;
- source and fence metadata never cross into fallback HTML unescaped;
- an unsupported language returns one escaped plaintext block and one
  actionable `FERRIKI_HIGHLIGHT_FALLBACK` diagnostic;
- the adapter uses only public Ferriki APIs and performs language loading at
  its async construction boundary.

## Rollback

Keep the Shiki adapter behind the same highlighter interface while migrating.
If a target cannot install the Ferriki binary, fail the deployment explicitly
or select the Shiki implementation before rendering begins. Do not switch
backends through Ferriki environment variables; the package has one native
runtime.
