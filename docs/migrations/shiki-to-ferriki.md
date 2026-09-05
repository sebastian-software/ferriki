# Migrating from Shiki to Ferriki

Ferriki follows the Shiki API shape but has a deliberately smaller native-only
runtime. This guide is for a Shiki **v4.4.3** consumer moving to the Ferriki
pre-1.0 package.

## Before changing code

1. Confirm that your deployment can install a Ferriki native binary.
2. Pin the Ferriki version in the same lockfile as Ferromark/Ardo.
3. Run the packed-package smoke test in CI; a repository checkout is not a
   valid substitute for an installed package.
4. Decide where transformer, decoration, and Markdown adapter behavior will
   live. They are not Ferriki core APIs.

## Compatibility matrix

| Shiki surface | Ferriki status | Migration |
| --- | --- | --- |
| `codeToHtml`, `codeToHast`, `codeToTokens` | Supported | Keep the call shape; use a Ferriki theme/language ID. |
| Reusable highlighters and singleton | Supported | Keep the factory pattern and dispose long-lived instances explicitly. |
| Standard language/theme loaders and aliases | Supported | Use `bundledLanguages`, `bundledThemes`, and `bundledLanguagesAlias`. |
| Custom TextMate grammar/theme registrations | Supported | Pass validated JSON-shaped registrations to the factory or load methods. |
| Ordered `themes` map and `defaultColor: false` | Supported | Use for Ardo/Ferromark light/dark output. |
| HAST serialization | Supported | Use `codeToHast` plus `hastToHtml`; sanitize at your application boundary. |
| `transformers`, decorations, `rehype`, `markdown-it` adapters | Not a Ferriki core API | Keep the adapter in Ferromark/your Markdown layer; callbacks never cross N-API. |
| JavaScript/Oniguruma engine injection | Removed | Ferriki owns native matching; remove `engine` and engine factories. |
| `loadWasm`/`wasmBinary` | Removed | Install the platform package/binary instead. |
| `lang: 'ansi'` with escape sequences | Rejected | Strip or parse terminal control sequences first. |
| Browser runtime | Unsupported | Run Ferriki in Node or use a separate browser highlighter. |

The exact baseline and exclusions are machine-checked from the pinned Shiki
mirror. “Shiki-compatible” means a tested subset, not that every Shiki package
is a Ferriki feature.

## Typical replacement

```diff
- import { createHighlighter } from 'shiki'
+ import { createHighlighter } from 'ferriki'

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

Unknown languages should be handled at the document integration boundary. The
Ferromark adapter can escape the original code and emit one diagnostic, but it
must not insert unescaped source or fence metadata into HTML.

## Ferromark and Ardo

Ferromark's highlighter adapter is synchronous. Load every language needed by
the document before rendering, pass fence metadata as `meta.__raw`, and treat
the returned HTML as trusted only after the adapter's documented escaping
boundary. Ardo owns code-block containers, titles, line numbers, and fallback
policy; Ferriki owns highlighting and HAST/HTML/token output. The contract and
representative executable consumer are documented in
[`docs/examples/ferromark-ardo.mjs`](../examples/ferromark-ardo.mjs).

## Rollback

Keep the Shiki adapter behind the same highlighter interface while migrating.
If a target cannot install the Ferriki binary, fail the deployment explicitly
or select the Shiki implementation before rendering begins. Do not switch
backends through Ferriki environment variables; the package has one native
runtime.
