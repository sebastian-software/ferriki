# Ferriki 1.0 API reference

This is the public API reference for the `@ferriki/core` package. The declaration
source [`node/ferriki/src/api.mts`](../node/ferriki/src/api.mts) generates the
published declaration wrapper [`node/ferriki/index.d.mts`](../node/ferriki/index.d.mts).
The CI docs gate checks that every generated public symbol is represented here.

The retained declaration symbols are `LanguageRegistration`,
`ThemeRegistration`, `LanguageInput`, `ThemeInput`, `SyncRegistrationInput`,
`RegistrationInput`, `AssetOptions`, `HighlighterOptions`, `HighlighterSyncOptions`,
`HighlightOptions`, `HtmlWithCss`, `ThemedToken`, `HastText`, `HastElement`,
`HastRoot`, `HastNode`, `DecorationItem`, `ShikiTransformerContextCommon`,
`ShikiTransformerContext`, `ShikiTransformer`, `GrammarState`, `Highlighter`,
`ShikiError`, `ferrikiVersion`,
`createHighlighter`, `createHighlighterCore`, `createShikiPrimitiveAsync`,
`createHighlighterCoreSync`, `createShikiPrimitive`, `getSingletonHighlighter`,
`getSingletonHighlighterCore`, `codeToHtmlWithCss`, `codeToHtml`,
`getLastGrammarState`, `CssVariablesThemeOptions`, `createCssVariablesTheme`,
`bundledLanguages`, `bundledThemes`, `bundledLanguagesAlias`,
`BundledLanguage`, `BundledTheme`, `FerrikiErrorCode`, and `FerrikiError`.

HTML is the Node output: `codeToHtml` and `codeToHtmlWithCss` render it, as
top-level functions and as highlighter methods. Transformer callbacks receive
typed token payloads and Ferriki HAST nodes during rendering. Shiki's
`codeToHast`, `codeToTokens`, `codeToTokensBase`, `codeToTokensWithThemes`,
and `hastToHtml` are not part of this API; Rust consumers get tokens from the
`ferriki` crate.

## Runtime requirements

- Node.js 22.13.0 or newer.
- A supported native binary for the current OS and architecture.
- The package is ESM-only. Use `import`, not `require()`.

The supported platform policy is intentionally explicit. Ferriki supports
Linux x64/arm64 with glibc or musl (Alpine), macOS arm64 (Apple Silicon), and Windows
x64/arm64 with Node.js 22.13.0+. macOS Intel and other architectures are unsupported. If the
native loader cannot find a binary it reports the target, optional package
candidate, and every path it tried.

## One-shot functions

All one-shot functions use the singleton highlighter. They return a Promise
when called without an existing highlighter and are synchronous when passed a
highlighter as the first argument.

```ts
codeToHtml(code, options): Promise<string>
codeToHtml(highlighter, code, options): string

codeToHtmlWithCss(code, options): Promise<HtmlWithCss>
codeToHtmlWithCss(highlighter, code, options): HtmlWithCss

getLastGrammarState(code, options): Promise<GrammarState>
getLastGrammarState(highlighter, code, options): GrammarState
```

`codeToHtml` returns HTML with source text escaped and Shiki-compatible line and
token structure. `codeToHtmlWithCss` returns the same rendered markup plus
resolved theme CSS. Transformer and decoration callbacks can change the HAST,
and a transformer `postprocess` hook can replace the HTML. Ferriki does not
sanitize callback changes; the caller is responsible for callback-generated
markup.

`getLastGrammarState` accepts source text and highlight options; pass its result
to a later HTML call through `grammarState` to continue grammar inference. It
requires a grammar-backed language: `text`, `txt`, `plain`, `plaintext`, and
`ansi` are rejected. Although `lang` is required by the TypeScript declaration,
HTML calls default an omitted runtime value to `text`, so pass a grammar language
explicitly to `getLastGrammarState`. It does not accept a token or HAST result.

The renderer uses token and HAST structures internally for transformer and
decoration callbacks. Those callback payloads retain Ferriki's typed token and
HAST data, including `scopeNames` and `type` metadata selected by
`includeExplanation`, but the package has no public method that returns them
directly.

`codeToHtmlWithCss` always renders classes and returns `{ html, css }`. Existing
TextMate themes work unchanged. Combine CSS from every rendered block. With a
`themes` map, set `data-ferriki-theme` on the root or an ancestor to switch themes
without replacing tokens. See [Class-based highlighting](class-highlighting.md)
for scope selectors, custom CSS, switching, and transformer behavior.

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

| Option           | Type                                 | Meaning                                                                                                   |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `langs`          | `RegistrationInput<LanguageInput>[]` | Languages or loader functions to load before the factory resolves.                                        |
| `themes`         | `RegistrationInput<ThemeInput>[]`    | Themes or loader functions to load before the factory resolves.                                           |
| `langAlias`      | `Record<string, string>`             | Per-highlighter aliases. Circular aliases throw `ShikiError`.                                             |
| `transformers`   | `ShikiTransformer[]`                 | JavaScript-only callbacks that inspect or change data during HTML rendering.                              |
| `assets`         | `AssetOptions`                       | Where standard grammars and themes come from; see below.                                                  |
| `regexPrefilter` | `boolean`                            | Automatic regex prefiltering (default `true`); `false` avoids construction for a short-lived highlighter. |

`HighlighterSyncOptions` has the same fields but excludes promises and loader
functions. Unknown options are rejected by the public TypeScript declarations
and are not a supported extension point. Additions require an explicit API
contract and compatibility coverage.

### Choosing the regex prefilter

For a CMS, documentation server or site build, reuse a highlighter and keep
the default `regexPrefilter: true`. Its automatic warm-up counts scanner
searches, not highlighting calls. The top-level `codeToHtml()` shorthand also
reuses a process-local singleton; one call per block does not mean one
highlighter per block.

For a short-lived process that creates a highlighter and uses it once,
`regexPrefilter: false` avoids prefilter construction. Choose it at creation,
including the singleton's first creation; it is not a per-call
`HighlightOptions` setting. Matching and colors remain the same.

The [two-host Blacksmith run](benchmarks/blacksmith/2026-10-10/README.md)
recorded 35–37% shorter first use with the prefilter disabled, but 51–68%
longer warm repository highlighting. First use includes imports, setup and
rendering all 14 corpus files, excluding process creation and downloads.
These Node HTML measurements do not predict one isolated snippet. JSON/Astro
on/off timings do not establish a specific benefit; unchanged controls also
moved between the macOS measurement windows.

```js
const highlighter = await createHighlighter({
  langs: ["typescript"],
  themes: ["github-dark"],
  regexPrefilter: false,
});
try {
  const html = highlighter.codeToHtml(code, { lang: "typescript", theme: "github-dark" });
} finally {
  highlighter.dispose();
}
```

Constructor `transformers` are defaults for `codeToHtml` and
`codeToHtmlWithCss`. A call with no `transformers` (or `undefined`) inherits
them. An explicit list replaces them; `[]` disables them for that call. Both
async and sync constructors copy the array and keep the existing
`enforce: 'pre'`, normal, `enforce: 'post'` ordering, preserving list order
within each tier. HTML rendering runs token and HAST hooks internally before
`postprocess`. Their typed token payloads, HAST nodes, and `scopeNames`/`type`
metadata selected by `includeExplanation` are available to callbacks, but the
public API has no standalone HAST or token methods, including
`codeToHast`/`codeToTokens` helpers on transformer contexts.
The singleton keeps the defaults from its first creation; later singleton
calls only add languages and themes.

### Standard assets

`@ferriki/core` ships the language and theme catalogs, but no grammar or theme
payloads. A payload is downloaded from a mirror pinned to the package's release
commit the first time it is loaded, verified against its SHA-256 digest, and
cached; later loads, processes and releases with unchanged payloads read the
cache ([ADR 0013](../adr/0013-cdn-loaded-standard-assets.md)).

| `AssetOptions` field | Environment variable                                         | Default                                                                                      |
| -------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `remote: boolean`    | `FERRIKI_ASSETS_REMOTE` (`0` or `false` turns downloads off) | `true`                                                                                       |
| `baseUrl: string`    | `FERRIKI_ASSETS_BASE_URL`                                    | `https://assets.ferriki.dev`                                                                 |
| `cacheDir: string`   | `FERRIKI_CACHE_DIR`                                          | `node_modules/.cache/ferriki` of the nearest package root, else the platform cache directory |

An explicit option wins over the environment. The one-shot functions use the
singleton highlighter, which only the environment configures.

Downloads happen only in the asynchronous paths: `createHighlighter`,
`getSingletonHighlighter`, `loadLanguage`, `loadTheme` and the one-shot
functions, which load the `lang`, `theme` and `themes` they are given. A
language's embedded languages are fetched with it. The synchronous factories,
`loadLanguageSync`, `loadThemeSync` and highlighting with an unloaded standard
language or theme never perform I/O beyond the cache; a payload that is not
cached fails with `ERR_ASSET` and names the remedies.

Offline, air-gapped and network-less CI builds either reuse a cache populated
by one online run, or point `FERRIKI_ASSETS_BASE_URL` at a mirror that serves
the repository's `assets/shiki/` below `<release-commit>/assets/shiki/`. See
[troubleshooting](./troubleshooting.md#offline-and-air-gapped-use).

## Highlighter methods

| Method                                           | Result                  | Notes                                                         |
| ------------------------------------------------ | ----------------------- | ------------------------------------------------------------- |
| `codeToHtml(code, options)`                      | `string`                | Render highlighted HTML.                                      |
| `codeToHtmlWithCss(code, options)`               | `HtmlWithCss`           | Render class-based HTML and return resolved CSS.              |
| `highlighter.getLastGrammarState(code, options)` | `GrammarState`          | Synchronous highlighter method for capturing grammar context. |
| `getLastGrammarState(code, options)`             | `Promise<GrammarState>` | Capture a serializable grammar context for continuation.      |
| `loadLanguage(...inputs)`                        | `Promise<void>`         | Load standard or custom grammars.                             |
| `loadLanguageSync(...inputs)`                    | `void`                  | Synchronous form for resolved registrations.                  |
| `loadTheme(...inputs)`                           | `Promise<void>`         | Load standard or custom themes.                               |
| `loadThemeSync(...inputs)`                       | `void`                  | Synchronous form for resolved registrations.                  |
| `getLoadedLanguages()`                           | `string[]`              | Loaded canonical language IDs plus configured aliases.        |
| `getLoadedThemes()`                              | `string[]`              | Loaded theme IDs.                                             |
| `resolveLangAlias(language)`                     | `string`                | Resolve the configured alias chain.                           |
| `dispose()`                                      | `void`                  | Mark the highlighter disposed and release native state.       |
| `[Symbol.dispose]()`                             | `void`                  | Equivalent to `dispose()`.                                    |

Calls after disposal throw `ShikiError`. Disposal clears native grammar/theme
registries and asset caches deterministically; a disposed wrapper cannot be
reused. A highlighter is synchronous after creation, so calls on one instance
are serialized by the Node event loop. Do not share one across workers without
an explicit worker boundary; create one highlighter per worker instead.

## Highlight options

| Option                  | Type                                    | Meaning                                                                                                                              |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `styleMode`             | `"inline" \| "classes"`                 | Inline styles by default; classes preserve nested grammar scopes.                                                                    |
| `lang`                  | `LanguageInput`                         | Required by the TypeScript declaration; HTML calls default an omitted runtime value to `text`.                                       |
| `theme`                 | `ThemeInput`                            | One theme ID or registration. Required unless `themes` is supplied.                                                                  |
| `themes`                | `Record<string, ThemeInput>`            | Ordered theme map, for example `{ light, dark }`.                                                                                    |
| `defaultColor`          | `string \| false`                       | Default foreground color; `false` disables the default color.                                                                        |
| `cssVariablePrefix`     | `string`                                | Prefix used for multi-theme CSS variables.                                                                                           |
| `includeExplanation`    | `boolean \| 'scopeName' \| 'tokenType'` | Include `scopeNames` and `type` metadata in token callback payloads.                                                                 |
| `grammarState`          | `GrammarState`                          | Continue HTML grammar inference from a state returned by `getLastGrammarState(code, options)`.                                       |
| `mergeWhitespaces`      | `boolean`                               | Merge adjacent whitespace tokens where possible.                                                                                     |
| `mergeSameStyleTokens`  | `boolean`                               | Merge adjacent tokens with the same style.                                                                                           |
| `rootStyle`             | `string \| false`                       | Inline style on the root element.                                                                                                    |
| `tabindex`              | `string \| number \| false \| null`     | Root `tabindex` attribute.                                                                                                           |
| `tokenizeMaxLineLength` | `number`                                | Maximum tokenized line length.                                                                                                       |
| `tokenizeTimeLimit`     | `number`                                | Tokenization time budget in milliseconds.                                                                                            |
| `structure`             | `'classic'                              | 'inline'`                                                                                                                            | Select the classic `<pre><code>` tree or inline token tree. |
| `meta`                  | `Record<string, unknown>`               | Fence metadata copied to the root HAST element, except private `_` keys.                                                             |
| `data`                  | `Record<string, unknown>`               | Callback-only metadata on the classic root `<pre>` HAST node; omitted from HTML serialization. Inline structure has no `<pre>` node. |
| `transformers`          | `ShikiTransformer[]`                    | Ordered JS hooks; callbacks never cross the native boundary.                                                                         |
| `decorations`           | `DecorationItem[]`                      | Validated UTF-16 ranges applied around highlighted HAST sections.                                                                    |

`tokenizeTimeLimit` defaults to 500 ms per line; `0` disables the time limit.
`tokenizeMaxLineLength` defaults to `0` (unlimited). When a non-zero line
length limit is reached, Ferriki renders that line as deliberately unstyled
HTML instead of silently claiming syntax-level highlighting. A tokenization
timeout follows the native TextMate stopped-early behavior and remains
observable in the HTML and transformer callback payloads.

ANSI escape sequences are outside the Ferriki 1.0 contract. Passing escape
bytes with `lang: 'ansi'` throws `ShikiError`; strip or parse terminal output
before highlighting.

Transformers run in this order: `preprocess`, `tokens`, `span`, `line`, `code`,
`pre`, `root`, and `postprocess` during HTML rendering. `enforce: 'pre'` and
`enforce: 'post'` group transformers around the normal tier. When provided,
`meta.__raw` is available to transformer callbacks through
`this.options.meta.__raw`. A `DecorationItem.transform` callback instead
receives `(element, type)` and does not receive the transformer context.

### Callback context and return values

Hooks run synchronously. Within each stage, Ferriki runs the `pre` tier, the
normal tier, and the `post` tier, preserving the supplied order inside each
tier. `span` and `line` stages repeat as each line is assembled: all spans of a
line run before that line's hook. `line` and `span` receive a one-based line
number; `span` receives a zero-based token column, not a character offset.

| Stage | Available context and behavior |
| --- | --- |
| `preprocess` | `options` and a mutable `meta` object. The source argument is the current text after earlier preprocess hooks. |
| `tokens` | The same `options` and `meta`, plus `source` containing the preprocessed text. Tokens have not yet been split at decoration boundaries. |
| `span`, `line` | The render context adds `root`, split `tokens`, `lines`, `structure`, and `addClassToHast`. `lines` contains only completed lines; `pre` and `code` are still `undefined`. The root is still being assembled. |
| `code`, `pre`, `root` | `code` is available. `pre` is available only for classic structure; inline output skips the `pre` hook. The getters follow replacement code/pre nodes. For inline structure, the code wrapper is detached: its properties and replacement do not enter the output, although mutations to shared line children do. `root` receives the decorated tree before final scope nesting and CSS extraction. |
| `postprocess` | `options` and a new `meta` object shared among postprocess hooks for that call. It does not share the earlier rendering stages' `meta` or expose the render tree. |

Token and HAST hooks may mutate their argument and return `undefined`, or
return replacement tokens/nodes for the following hooks. Returning a nonempty
string from `preprocess` or `postprocess` replaces the current text; an omitted
return or empty string leaves it unchanged. Hooks are not awaited; async
callbacks are outside this contract. A thrown callback error aborts rendering
and propagates unchanged, without disposing the highlighter or rolling back
mutations already visible to callbacks.

Use the hook argument for its current node. `this.root` refers to the original
root container; returning a different root passes that replacement onward but
does not change `this.root`. Guard `this.pre` and `this.code` when accessing
them through the shared `ShikiTransformerContext` type. Read fence metadata
from `this.options.meta`; `this.meta` is callback scratch data, and
`HighlightOptions.data` is separate metadata on the classic `<pre>` node.
The full upstream Shiki context is not interchangeable with this contract.

Decoration positions are finite integers: an absolute UTF-16 offset, or a
zero-based `{ line, character }`. A negative character counts backward from
that line's length, excluding a trailing carriage return. Nested, touching,
and empty ranges are supported; crossing overlaps and reversed ranges throw
`ERR_USAGE`. Source ranges use the preprocessed code. Decorations split tokens
after token hooks and apply to the current tree after `pre` hooks, before
`root`, scope nesting, and class extraction. A decoration callback receives
`line`, `token`, or `wrapper` as its second argument; its `this` value is the
resolved decoration, including `{ line, character, offset }` for both bounds.
Later sections observe its mutations and returned replacement nodes.

### Declarative line and range highlighting

Pass decorations with the highlight request. For example, this marks displayed
lines 4 through 10 in a source with at least ten lines; positions are zero-based and the end
character is exclusive:

```ts
const lines = source.split("\n");
const html = highlighter.codeToHtml(source, {
  lang: "typescript",
  theme: "nord",
  decorations: [{
    start: { line: 3, character: 0 },
    end: { line: 9, character: lines[9].replace(/\r$/, "").length },
    properties: { class: "line highlighted" },
  }],
});
```

With classic structure, a single theme, inline theme styles, and no transformers
or decoration callbacks, plain decorations with string attributes render
entirely in Rust. This includes partial ranges, nesting, `alwaysWrap`, tags,
classes, and string attributes. No new option is required: Ferriki chooses the
path automatically and returns the same HTML.

Callbacks, class-based theme CSS, multi-theme output, inline structure, grammar
state, block metadata, accessors/custom prototypes, proxies, and non-string properties
use the existing host pipeline. String slices inside UTF-16 surrogate pairs and
lone surrogate strings also keep that path. The stable public Rust API is
unchanged; this renderer belongs to the private Node consumer bridge.

## Registrations and loaders

`LanguageRegistration` and `ThemeRegistration` accept the JSON-shaped
TextMate structures used by Shiki. Ferriki validates them before sending them
to the native runtime. A registration can be supplied directly, wrapped in a
`{ default: ... }` object, nested in an array, returned by a loader function,
or returned by a promise (async factories only).

```ts
type LanguageInput = string | LanguageRegistration;
type ThemeInput = string | ThemeRegistration;
type SyncRegistrationInput<T> =
  T | { default: SyncRegistrationInput<T> } | readonly SyncRegistrationInput<T>[];
type RegistrationInput<T> =
  SyncRegistrationInput<T> | PromiseLike<RegistrationInput<T>> | (() => RegistrationInput<T>);
```

Custom language registrations need `name`, `scopeName`, and valid TextMate
patterns. Custom theme registrations need `name` and valid settings. Custom
aliases are added to the highlighter only; aliases belonging to the standard
catalog cannot be overwritten.

`bundledLanguages` and `bundledThemes` are frozen, enumerable loader maps.
`bundledLanguagesAlias` maps every bundled alias to its canonical language ID.
`BundledLanguage` and `BundledTheme` are key unions for those maps and are
provided for typed consumers such as Ardo configuration and language guards.

## Results and helpers

```ts
interface ThemedToken {
  scopeNames?: readonly string[];
  content: string;
  offset: number;
  htmlAttrs?: Readonly<Record<string, string>>;
  color?: string;
  fontStyle?: number;
  type?: number;
  htmlStyle?: Readonly<Record<string, string>>;
  variants?: Readonly<Record<string, { color?: string; fontStyle?: number }>>;
}

interface GrammarState {
  version: 1;
  lang: string;
  theme: string;
  themes: string[];
  scopes: string[];
  source: string;
}
```

`includeExplanation: 'scopeName'` (or `true`) includes the TextMate
`scopeNames` in token callback payloads. The `'tokenType'` mode includes numeric
`type` metadata without scope paths. It does not create a standalone token
result or an `explanation` array.
`getLastGrammarState` and the `grammarState` option provide a validated,
serializable continuation context. A state from another language or a theme
not present in the current highlight call is rejected with `ShikiError`.

`HighlightOptions.data` is callback-only metadata. In classic structure it is
attached to the internal root `<pre>` HAST node's `data` field for callbacks;
the HTML serializer omits that field, and no public render method returns the
node. Inline structure has no `<pre>` node.

`HastRoot`, `HastElement`, `HastText`, and `HastNode` are the small serializable
HAST types used by transformer and decoration callbacks. They are not returned
by a public render method, and `hastToHtml` is not exported. Apply the same
trust boundary to HTML changes made by callbacks as to any generated markup.

`createCssVariablesTheme(options)` creates a theme registration whose default
foreground/background use CSS variables. It does not load the theme itself.

`ferrikiVersion()` returns the loaded native core version, or `undefined` when
the current platform binding is unavailable.

## Errors and deliberate boundaries

User-facing validation, missing language/theme, circular aliases, disposal,
and ANSI input are reported as `ShikiError` with a stable `code`. Native
operation failures are reported as the `FerrikiError` subclass, which remains
an `instanceof ShikiError` for existing consumers. The supported codes are:

| Code                 | Meaning                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ERR_USAGE`          | Invalid public options, registrations, aliases, or lifecycle use.                                                      |
| `ERR_UNSUPPORTED`    | A deliberate capability boundary, missing language/theme, or ANSI input.                                               |
| `ERR_NATIVE_LOAD`    | No loadable platform addon for the current target.                                                                     |
| `ERR_ASSET`          | A standard asset could not be downloaded, verified or found in the cache, or a native registration payload is invalid. |
| `ERR_RESOURCE_LIMIT` | Tokenization exceeded a documented time/size/resource limit.                                                           |
| `ERR_INTERNAL`       | An unexpected native or facade failure.                                                                                |

`FerrikiError` preserves the original native exception in `cause` without
making its implementation text part of the contract. Native loader messages
remain actionable and start with the documented `[ferriki]` prefix.

Ferriki exposes `transformers` and `decorations` through its JavaScript facade.
Transformer and decoration callbacks stay in JavaScript. Rust resolves decoration
ranges, splits token boundaries, and plans tree edits; the facade applies those
edits to the existing objects in the host pipeline. Plain declarative HTML
uses the complete native renderer described above, with ordered string
attributes. Callback payloads and opaque properties do not cross the native
boundary. Public Node rendering returns HTML
only. Ferriki does not export Shiki's JavaScript/Oniguruma engine factories or
WASM loading. Markdown adapters such as `rehype` and `markdown-it`, and the
optional Vite integration, are separate packages rather than `@ferriki/core`
exports. See the [migration guide](./migrations/shiki-to-ferriki.md) for the
supported boundary.
For focus, highlights, diffs, and collapsible examples across Node, Vite, and
Ferromark, see [code example authoring](./code-example-authoring.md).

## Native binding

The raw N-API binding and its loader are internal. `@ferriki/core` exports no
native subpath, so runtime validation and the public error contract always
apply. Use `ferrikiVersion()` to check whether the platform binding loaded; it
returns `undefined` when no supported binary is installed.

## Build-time inline macros

`@ferriki/core/macro` exposes the browser-safe `code` marker and
`PreparedCodeBlock` type. `@ferriki/core/react/macro` exposes the optional React
`Code` JSX marker with a literal `source` attribute, optional runtime `className`
and an explicit `render` function receiving `CodeRenderProps`. Both are erased
during the build; the React marker adds no React runtime import to the core package.
`@ferriki/vite` recognizes the markers; `@ferriki/core` ships no macro scanner,
and these entries are separate from the root highlighter exports. See
[Inline code macros](inline-code-macros.md) for the literal-only contract, Vite
setup and prepared HTML/CSS.
