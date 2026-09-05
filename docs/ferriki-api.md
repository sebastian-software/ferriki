# Ferriki 1.0 API reference

This is the public API reference for the `ferriki` package. The declaration
file [`node/ferriki/index.d.mts`](../node/ferriki/index.d.mts) is the type-level
source of truth; the CI docs gate checks that every declared public symbol is
represented here.

The retained declaration symbols are `LanguageRegistration`,
`ThemeRegistration`, `LanguageInput`, `ThemeInput`, `SyncRegistrationInput`,
`RegistrationInput`, `HighlighterOptions`, `HighlighterSyncOptions`,
`HighlightOptions`, `ThemedToken`, `TokensResult`, `HastText`, `HastElement`,
`HastRoot`, `HastNode`, `DecorationItem`, `ShikiTransformerContextCommon`,
`ShikiTransformerContext`, `ShikiTransformer`, `ThemedTokenScopeExplanation`,
`ThemedTokenExplanation`, `GrammarState`, `Highlighter`, `ShikiError`, `ferrikiVersion`,
`createHighlighter`, `createHighlighterCore`, `createShikiPrimitiveAsync`,
`createHighlighterCoreSync`, `createShikiPrimitive`, `getSingletonHighlighter`,
`getSingletonHighlighterCore`, `codeToHtml`, `codeToHast`, `codeToTokens`,
`codeToTokensBase`, `codeToTokensWithThemes`, `getLastGrammarState`,
`CssVariablesThemeOptions`, `createCssVariablesTheme`, `hastToHtml`,
`bundledLanguages`, `bundledThemes`, `bundledLanguagesAlias`, and
`FerrikiErrorCode`, `FerrikiError`.

## Runtime requirements

- Node.js 22.13.0 or newer.
- A supported native binary for the current OS and architecture.
- The package is ESM-only. Use `import`, not `require()`.

The supported platform policy is intentionally explicit. Ferriki supports
Linux x64/arm64 with glibc, macOS arm64/x64, and Windows x64 with Node.js
22.13.0+. Linux musl/Alpine and other architectures are unsupported. If the
native loader cannot find a binary it reports the target, optional package
candidate, and every path it tried.

## One-shot functions

All one-shot functions use the singleton highlighter. They return a Promise
when called without an existing highlighter and are synchronous when passed a
highlighter as the first argument.

```ts
codeToHtml(code, options): Promise<string>
codeToHtml(highlighter, code, options): string

codeToHast(code, options): Promise<HastRoot>
codeToHast(highlighter, code, options): HastRoot

codeToTokens(code, options): Promise<TokensResult>
codeToTokens(highlighter, code, options): TokensResult

codeToTokensBase(code, options): Promise<ThemedToken[][]>
codeToTokensBase(highlighter, code, options): ThemedToken[][]

codeToTokensWithThemes(code, options): Promise<ThemedToken[][]>
codeToTokensWithThemes(highlighter, code, options): ThemedToken[][]

getLastGrammarState(code, options): Promise<GrammarState>
getLastGrammarState(highlighter, code, options): GrammarState
```

`codeToHtml` returns escaped HTML with Shiki-compatible line and token
structure. `codeToHast` returns the equivalent serializable HAST tree.
`codeToTokens` returns token metadata plus foreground/background information.
The `Base` and `WithThemes` helpers return only the token matrix from the
corresponding result.

## Highlighter factories

```ts
createHighlighter(options?): Promise<Highlighter>
createHighlighterCore(options?): Promise<Highlighter>
createShikiPrimitiveAsync(options?): Promise<Highlighter>

createHighlighterCoreSync(options?): Highlighter
createShikiPrimitive(options?): Highlighter

getSingletonHighlighter(options?): Promise<Highlighter>
getSingletonHighlighterCore(options?): Promise<Highlighter>
```

`createHighlighter` resolves loader functions and promises before returning.
The synchronous factories accept only already-resolved registrations. Use
`using highlighter = await createHighlighter(...)` or call `dispose()` when a
highlighter is no longer needed.

### Highlighter options

| Option | Type | Meaning |
| --- | --- | --- |
| `langs` | `RegistrationInput<LanguageInput>[]` | Languages or loader functions to load before the factory resolves. |
| `themes` | `RegistrationInput<ThemeInput>[]` | Themes or loader functions to load before the factory resolves. |
| `langAlias` | `Record<string, string>` | Per-highlighter aliases. Circular aliases throw `ShikiError`. |
| `transformers` | `ShikiTransformer[]` | JavaScript-only callbacks for the documented token/HAST pipeline. |

`HighlighterSyncOptions` has the same fields but excludes promises and loader
functions. Unknown options are rejected by the public TypeScript declarations
and are not a supported extension point. Additions require an explicit API
contract and compatibility coverage.

## Highlighter methods

| Method | Result | Notes |
| --- | --- | --- |
| `codeToHtml(code, options)` | `string` | Render highlighted HTML. |
| `codeToHast(code, options)` | `HastRoot` | Render the serializable HAST equivalent. |
| `codeToTokens(code, options)` | `TokensResult` | Return tokens and theme metadata. |
| `codeToTokensBase(code, options)` | `ThemedToken[][]` | Return the token matrix. |
| `codeToTokensWithThemes(code, options)` | `ThemedToken[][]` | Return aligned tokens for a theme map. |
| `highlighter.getLastGrammarState(code, options)` | `GrammarState` | Synchronous highlighter method for capturing grammar context. |
| `getLastGrammarState(code, options)` | `Promise<GrammarState>` | Capture a serializable grammar context for continuation. |
| `loadLanguage(...inputs)` | `Promise<void>` | Load standard or custom grammars. |
| `loadLanguageSync(...inputs)` | `void` | Synchronous form for resolved registrations. |
| `loadTheme(...inputs)` | `Promise<void>` | Load standard or custom themes. |
| `loadThemeSync(...inputs)` | `void` | Synchronous form for resolved registrations. |
| `getLoadedLanguages()` | `string[]` | Loaded canonical language IDs plus configured aliases. |
| `getLoadedThemes()` | `string[]` | Loaded theme IDs. |
| `resolveLangAlias(language)` | `string` | Resolve the configured alias chain. |
| `dispose()` | `void` | Mark the highlighter disposed and release native state. |
| `[Symbol.dispose]()` | `void` | Equivalent to `dispose()`. |

Calls after disposal throw `ShikiError`. Disposal clears native grammar/theme
registries and asset caches deterministically; a disposed wrapper cannot be
reused. A highlighter is synchronous after creation, so calls on one instance
are serialized by the Node event loop. Do not share one across workers without
an explicit worker boundary; create one highlighter per worker instead.

## Highlight options

| Option | Type | Meaning |
| --- | --- | --- |
| `lang` | `LanguageInput` | Language ID, alias, or a custom registration. Defaults to `text`. |
| `theme` | `ThemeInput` | One theme ID or registration. Required unless `themes` is supplied. |
| `themes` | `Record<string, ThemeInput>` | Ordered theme map, for example `{ light, dark }`. |
| `defaultColor` | `string \| false` | Default foreground color; `false` disables the default color. |
| `cssVariablePrefix` | `string` | Prefix used for multi-theme CSS variables. |
| `includeExplanation` | `boolean \| 'scopeName' \| 'tokenType'` | Include the accepted token explanation metadata. |
| `grammarState` | `GrammarState` | Continue grammar inference from a state returned by `getLastGrammarState` or `codeToTokens`. |
| `mergeWhitespaces` | `boolean` | Merge adjacent whitespace tokens where possible. |
| `mergeSameStyleTokens` | `boolean` | Merge adjacent tokens with the same style. |
| `rootStyle` | `string \| false` | Inline style on the root element. |
| `tabindex` | `string \| number \| false \| null` | Root `tabindex` attribute. |
| `tokenizeMaxLineLength` | `number` | Maximum tokenized line length. |
| `tokenizeTimeLimit` | `number` | Tokenization time budget in milliseconds. |
| `structure` | `'classic' | 'inline'` | Select the classic `<pre><code>` tree or inline token tree. |
| `meta` | `Record<string, unknown>` | Fence metadata copied to the root HAST element, except private `_` keys. |
| `transformers` | `ShikiTransformer[]` | Ordered JS hooks; callbacks never cross the native boundary. |
| `decorations` | `DecorationItem[]` | Validated UTF-16 ranges applied around highlighted HAST sections. |

`tokenizeTimeLimit` defaults to 500 ms per line; `0` disables the time limit.
`tokenizeMaxLineLength` defaults to `0` (unlimited). When a non-zero line
length limit is reached, Ferriki returns that line as one deliberately
unstyled token instead of silently claiming syntax-level highlighting. A
tokenization timeout follows the native TextMate stopped-early behavior and
remains observable through the unstyled/partial token result.

ANSI escape sequences are outside the Ferriki 1.0 contract. Passing escape
bytes with `lang: 'ansi'` throws `ShikiError`; strip or parse terminal output
before highlighting.

Transformers run in this order: `preprocess`, `tokens`, `span`, `line`, `code`,
`pre`, `root`, and (for `codeToHtml`) `postprocess`. `enforce: 'pre'` and
`enforce: 'post'` group transformers around the normal tier. Decoration
callbacks run in the JS HAST layer and receive `meta.__raw` through the
transformer context without serializing callbacks into N-API.

## Registrations and loaders

`LanguageRegistration` and `ThemeRegistration` accept the JSON-shaped
TextMate structures used by Shiki. Ferriki validates them before sending them
to the native runtime. A registration can be supplied directly, wrapped in a
`{ default: ... }` object, nested in an array, returned by a loader function,
or returned by a promise (async factories only).

```ts
type LanguageInput = string | LanguageRegistration
type ThemeInput = string | ThemeRegistration
type SyncRegistrationInput<T> = T | { default: SyncRegistrationInput<T> }
  | readonly SyncRegistrationInput<T>[]
type RegistrationInput<T> = SyncRegistrationInput<T>
  | PromiseLike<RegistrationInput<T>>
  | (() => RegistrationInput<T>)
```

Custom language registrations need `name`, `scopeName`, and valid TextMate
patterns. Custom theme registrations need `name` and valid settings. Custom
aliases are added to the highlighter only; aliases belonging to the standard
catalog cannot be overwritten.

`bundledLanguages` and `bundledThemes` are frozen, enumerable loader maps.
`bundledLanguagesAlias` maps every bundled alias to its canonical language ID.

## Results and helpers

```ts
interface ThemedToken {
  content: string
  offset: number
  color?: string
  fontStyle?: number
  type?: number
  htmlStyle?: Record<string, string>
  variants?: Record<string, { color?: string; fontStyle?: number }>
  explanation?: ThemedTokenExplanation[]
}

interface ThemedTokenScopeExplanation {
  scopeName: string
}

interface ThemedTokenExplanation {
  content: string
  scopes: ThemedTokenScopeExplanation[]
}

interface GrammarState {
  version: 1
  lang: string
  theme: string
  themes: string[]
  scopes: string[]
  source: string
}

interface TokensResult {
  tokens: ThemedToken[][]
  fg: string
  bg: string
  themeName: string
  rootStyle?: string
  grammarState?: GrammarState
}
```

`includeExplanation: 'scopeName'` (or `true`) adds a serializable
`explanation` entry to every token with its TextMate scope path. The
`'tokenType'` mode retains the numeric `type` metadata without scope paths.
`getLastGrammarState` and the `grammarState` option provide a validated,
serializable continuation context. A state from another language or a theme
not present in the current highlight call is rejected with `ShikiError`.

`HastRoot`, `HastElement`, and `HastText` are the small serializable HAST
subset returned by Ferriki. `hastToHtml(tree)` serializes a root or element;
it does not sanitize arbitrary user-created nodes.

`createCssVariablesTheme(options)` creates a theme registration whose default
foreground/background use CSS variables. It does not load the theme itself.

`ferrikiVersion()` returns the loaded native core version, or `undefined` when
the current platform binding is unavailable.

## Errors and deliberate boundaries

User-facing validation, missing language/theme, circular aliases, disposal,
and ANSI input are reported as `ShikiError` with a stable `code`. Native
operation failures are reported as the `FerrikiError` subclass, which remains
an `instanceof ShikiError` for existing consumers. The supported codes are:

| Code | Meaning |
| --- | --- |
| `ERR_USAGE` | Invalid public options, registrations, aliases, or lifecycle use. |
| `ERR_UNSUPPORTED` | A deliberate capability boundary, missing language/theme, or ANSI input. |
| `ERR_NATIVE_LOAD` | No loadable platform addon for the current target. |
| `ERR_ASSET` | Missing/corrupt bundled assets or invalid native registration payload. |
| `ERR_RESOURCE_LIMIT` | Tokenization exceeded a documented time/size/resource limit. |
| `ERR_INTERNAL` | An unexpected native or facade failure. |

`FerrikiError` preserves the original native exception in `cause` without
making its implementation text part of the contract. Native loader messages
remain actionable and start with the documented `[ferriki]` prefix.

The following historical Shiki extension points are deliberately not Ferriki
exports: JavaScript/Oniguruma engine factories, WASM loading, transformer
callbacks, decoration adapters, and adapter packages such as `rehype` or
`markdown-it`. See the [migration guide](./migrations/shiki-to-ferriki.md) for
the supported replacement boundary.

## Native subpath

`ferriki/native` is a low-level diagnostic escape hatch. It exposes
`loadFerrikiNativeBinding()` and `tryLoadFerrikiNativeBinding()` plus the
native highlighter type. Applications should use the root API so runtime
validation and the public error contract remain intact.
