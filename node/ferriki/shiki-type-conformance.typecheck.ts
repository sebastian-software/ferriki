import type * as Shiki from "@shikijs/types";
import type * as Ferriki from "./index.d.mts";
import { transformerMetaHighlight } from "@shikijs/transformers";

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type AssertTrue<T extends true> = T;
type MissingKeys<T, Surface, Excluded extends PropertyKey> = Exclude<
  KeysOfUnion<T>,
  keyof Surface | Excluded
>;
type HasKeyCoverage<T, Surface, Excluded extends PropertyKey> = [
  MissingKeys<T, Surface, Excluded>,
] extends [never]
  ? true
  : false;

// Shiki options that Ferriki does not implement are explicit compatibility
// boundaries, not supported inputs to the native renderer.
type ShikiOnlyHighlightOptionKeys = "colorReplacements" | "colorsRendering" | "grammarContextCode";
type ShikiHighlightOptionTypeExceptions =
  | ShikiOnlyHighlightOptionKeys
  | "decorations"
  | "grammarState"
  | "transformers";
type ShikiThemeInputWithinFerrikiContract<T> = T extends string
  ? T
  : T extends PromiseLike<infer Value>
    ? PromiseLike<ShikiThemeInputWithinFerrikiContract<Value>>
    : T extends (...args: never[]) => infer Value
      ? (...args: never[]) => ShikiThemeInputWithinFerrikiContract<Value>
      : T extends readonly unknown[]
        ? { readonly [Index in keyof T]: ShikiThemeInputWithinFerrikiContract<T[Index]> }
        : T extends object
          ? T & { name: string }
          : never;
type ShikiThemeMapWithinFerrikiContract<T> = {
  [Color in keyof T]: ShikiThemeInputWithinFerrikiContract<T[Color]>;
};
type ShikiWhitespaceWithinFerrikiContract<T> = T extends {
  mergeWhitespaces?: infer Whitespace;
}
  ? { mergeWhitespaces?: Extract<Whitespace, boolean> }
  : unknown;
type ShikiHighlightOptionsWithinFerrikiContract<T> = T extends unknown
  ? T extends { theme: infer Theme }
    ? Omit<T, ShikiHighlightOptionTypeExceptions | "mergeWhitespaces" | "theme"> & {
        theme: ShikiThemeInputWithinFerrikiContract<Theme>;
      } & ShikiWhitespaceWithinFerrikiContract<T>
    : T extends { themes: infer Themes }
      ? Omit<T, ShikiHighlightOptionTypeExceptions | "mergeWhitespaces" | "themes"> & {
          themes: ShikiThemeMapWithinFerrikiContract<Themes>;
        } & ShikiWhitespaceWithinFerrikiContract<T>
      : never
  : never;

type _ShikiHighlightOptionKeyCoverage = AssertTrue<
  HasKeyCoverage<Shiki.CodeToHastOptions, Ferriki.HighlightOptions, ShikiOnlyHighlightOptionKeys>
>;

type RemovedNodeOutputNames =
  | "codeToHast"
  | "codeToTokens"
  | "codeToTokensBase"
  | "codeToTokensWithThemes"
  | "hastToHtml";
type FerrikiPublicApi = typeof import("./index.d.mts");
type _StructuredNodeOutputExportsAreRemoved = AssertTrue<
  [Extract<keyof FerrikiPublicApi, RemovedNodeOutputNames>] extends [never] ? true : false
>;
type _StructuredNodeOutputMethodsAreRemoved = AssertTrue<
  [Extract<keyof Ferriki.Highlighter, RemovedNodeOutputNames>] extends [never] ? true : false
>;
type _StructuredTransformerHelpersAreRemoved = AssertTrue<
  [Extract<keyof Ferriki.ShikiTransformerContextCommon, "codeToHast" | "codeToTokens">] extends [
    never,
  ]
    ? true
    : false
>;
// Ordinary structural assignment permits extra optional source properties to
// disappear, so this synthetic failure verifies the key guard catches drift.
type _SyntheticOptionalMirrorFieldDrift = AssertTrue<
  // @ts-expect-error A newly added optional Shiki field needs support or an explicit exception.
  HasKeyCoverage<
    { lang: string; theme: string; newlyAddedOptionalField?: boolean },
    Ferriki.HighlightOptions,
    ShikiOnlyHighlightOptionKeys
  >
>;

// Keep the shared output shape in sync in both directions. Ferriki's native
// GrammarState is serialized and is intentionally different from Shiki's.
declare const ferrikiToken: Ferriki.ThemedToken;
const shikiToken: Shiki.ThemedToken = ferrikiToken;
declare const shikiTokenValue: Shiki.ThemedToken;
const ferrikiTokenValue: Ferriki.ThemedToken = shikiTokenValue;

type ShikiThemedTokenKeyExceptions = "bgColor" | "explanation";
type FerrikiThemedTokenExtensions = "scopeNames" | "variants";
type _ThemedTokenKeyCoverage = AssertTrue<
  HasKeyCoverage<Shiki.ThemedToken, Ferriki.ThemedToken, ShikiThemedTokenKeyExceptions>
>;
type _FerrikiThemedTokenExtensionsAreListed = AssertTrue<
  HasKeyCoverage<Ferriki.ThemedToken, Shiki.ThemedToken, FerrikiThemedTokenExtensions>
>;

// Check the complete Shiki code-to-HAST option union after named-theme
// registrations, the documented callback/state boundaries, and the boolean-only
// whitespace value are applied.
declare const upstreamHighlightOptions: ShikiHighlightOptionsWithinFerrikiContract<Shiki.CodeToHastOptions>;
const ferrikiHighlightOptions: Ferriki.HighlightOptions = upstreamHighlightOptions;

// `themes` is partial on both APIs. Ferriki ignores an undefined theme entry
// when resolving themes; `resolveThemeEntries` filters nullish values.
const undefinedThemeOption = {
  lang: "typescript",
  themes: { light: "github-light", dark: undefined },
  defaultColor: "light",
} satisfies Shiki.CodeToHastOptions;
const ferrikiUndefinedThemeOption: Ferriki.HighlightOptions = undefinedThemeOption;

const namedShikiRawTheme = {
  name: "nord",
  colors: {},
  settings: [],
} satisfies Shiki.ThemeRegistrationRaw & { name: string };
const namedShikiThemeOption = {
  lang: "typescript",
  theme: namedShikiRawTheme,
} satisfies Shiki.CodeToHastOptions;
const ferrikiNamedShikiThemeOption: Ferriki.HighlightOptions = namedShikiThemeOption;

const unnamedShikiTheme = {
  colors: {},
  settings: [],
} satisfies Shiki.ThemeRegistrationRaw;
const unnamedShikiThemeOption = {
  lang: "typescript",
  theme: unnamedShikiTheme,
} satisfies Shiki.CodeToHastOptions;
// @ts-expect-error Ferriki requires a name for custom theme registrations.
const unsupportedUnnamedShikiTheme: Ferriki.HighlightOptions = unnamedShikiThemeOption;

// Ferriki accepts the Shiki tabindex string form (and also `null` as an
// extension); runtime validation preserves the accepted number/string forms.
const shikiStringTabindex = {
  lang: "typescript",
  theme: "nord",
  tabindex: "-1",
} satisfies Shiki.CodeToHastOptions;
const ferrikiStringTabindex: Ferriki.HighlightOptions = shikiStringTabindex;

const shikiNeverWhitespaceOptions = {
  lang: "typescript",
  theme: "nord",
  mergeWhitespaces: "never",
} satisfies Shiki.CodeToHastOptions;
// @ts-expect-error Ferriki's runtime accepts boolean whitespace merging only.
const unsupportedWhitespaceMode: Ferriki.HighlightOptions = shikiNeverWhitespaceOptions;

const unsupportedGrammarContextCode: Ferriki.HighlightOptions = {
  lang: "typescript",
  theme: "nord",
  // @ts-expect-error Shiki's grammarContextCode continuation is not implemented.
  grammarContextCode: "<template>",
};
const unsupportedColorsRendering: Ferriki.HighlightOptions = {
  lang: "typescript",
  themes: { light: "github-light", dark: "github-dark" },
  // @ts-expect-error Shiki's token colorsRendering option has no Ferriki contract.
  colorsRendering: "none",
};

const shikiColorReplacements = {
  lang: "typescript",
  theme: "nord",
  colorReplacements: { "#112233": "#445566" },
} satisfies Shiki.CodeToHastOptions;
const _unsupportedFerrikiColorReplacements: Ferriki.HighlightOptions = {
  lang: shikiColorReplacements.lang,
  theme: shikiColorReplacements.theme,
  // @ts-expect-error Color replacement is deferred until Ferriki implements it at runtime.
  colorReplacements: shikiColorReplacements.colorReplacements,
};

// Factory options retain all mirrored fields except the native-engine and
// warning controls. Theme registrations are limited to named values, matching
// the contract of Ferriki's registration resolver.
type ShikiFactoryOptionsWithinFerrikiContract<T> = Omit<T, "engine" | "warnings" | "themes"> & {
  themes?: T extends { themes?: (infer Theme)[] }
    ? readonly ShikiThemeInputWithinFerrikiContract<Theme>[]
    : never;
};
type ShikiFactoryOptionKeyCoverage<T> = HasKeyCoverage<
  T,
  Ferriki.HighlighterOptions,
  "engine" | "warnings"
>;
type ShikiAsyncFactoryOptions =
  ShikiFactoryOptionsWithinFerrikiContract<Shiki.HighlighterCoreOptions>;
type ShikiSyncFactoryOptions = ShikiFactoryOptionsWithinFerrikiContract<
  Shiki.HighlighterCoreOptions<true>
>;
type _ShikiAsyncFactoryOptionKeys = AssertTrue<
  ShikiFactoryOptionKeyCoverage<Shiki.HighlighterCoreOptions>
>;
type _ShikiSyncFactoryOptionKeys = AssertTrue<
  ShikiFactoryOptionKeyCoverage<Shiki.HighlighterCoreOptions<true>>
>;
declare const shikiAsyncFactoryOptions: ShikiAsyncFactoryOptions;
const ferrikiAsyncFactoryOptions: Ferriki.HighlighterOptions = shikiAsyncFactoryOptions;
declare const shikiSyncFactoryOptions: ShikiSyncFactoryOptions;
const ferrikiSyncFactoryOptions: Ferriki.HighlighterSyncOptions = shikiSyncFactoryOptions;

// Shared token hook payloads are interchangeable. Full contexts are not:
// Ferriki exposes its serializable native state, narrower option APIs, and
// serializable HAST nodes instead of Shiki's internal GrammarState/HAST types.
type ShikiTokenHook = OmitThisParameter<NonNullable<Shiki.ShikiTransformer["tokens"]>>;
type FerrikiTokenHook = OmitThisParameter<NonNullable<Ferriki.ShikiTransformer["tokens"]>>;
const shikiTokenHook: ShikiTokenHook = (tokens) => tokens;
const ferrikiTokenHook: FerrikiTokenHook = shikiTokenHook;

declare const shikiTransformerContext: Shiki.ShikiTransformerContext;
declare const ferrikiTransformerContext: Ferriki.ShikiTransformerContext;
const ferrikiContextSource: string = shikiTransformerContext.source;
const shikiContextSource: string = ferrikiTransformerContext.source;
const ferrikiContextTokens: Ferriki.ThemedToken[][] = shikiTransformerContext.tokens;
const shikiContextTokens: Shiki.ThemedToken[][] = ferrikiTransformerContext.tokens;

const ferrikiMetaTransformer: Ferriki.ShikiTransformer = {
  line(node) {
    const rawMeta: string | undefined = this.options.meta?.__raw;
    return rawMeta ? node : undefined;
  },
};

const ferrikiCallbackOnlyDataOptions = {
  lang: "javascript",
  theme: "nord",
  data: { marker: "from-options.data" },
} satisfies Ferriki.HighlightOptions;
const ferrikiDataTransformer: Ferriki.ShikiTransformer = {
  pre(node) {
    const marker = node.data?.marker;
    if (typeof marker === "string") node.properties["data-callback-marker"] = marker;
    return node;
  },
};

const shikiDecorationWithoutTransform = {
  start: 0,
  end: 1,
  tagName: "mark",
  properties: { className: "highlight" },
} satisfies Shiki.DecorationItem;
const ferrikiDecorationWithoutTransform: Ferriki.DecorationItem = shikiDecorationWithoutTransform;
const shikiDecorationWithTransform = {
  start: 0,
  end: 1,
  transform(element) {
    return element;
  },
} satisfies Shiki.DecorationItem;
// @ts-expect-error Shiki decoration transforms expect upstream HAST properties.
const incompatibleFerrikiDecoration: Ferriki.DecorationItem = shikiDecorationWithTransform;

declare const ferrikiHast: Ferriki.HastRoot;
// Ferriki permits unknown serializable properties for consumer metadata; it
// therefore does not claim the narrower @types/hast Root property contract.
// @ts-expect-error Ferriki's HAST tree is not a full upstream HAST Root.
const incompatibleShikiHast: Shiki.ShikiTransformerContext["root"] = ferrikiHast;

const shikiTransformer = transformerMetaHighlight();
// This real upstream helper relies on Shiki's transformer context. Runtime hooks
// are supported, but the complete upstream context is not type-interchangeable.
// @ts-expect-error Full ShikiTransformer context interchangeability is outside the Ferriki 1.0 contract.
const incompatibleFerrikiTransformer: Ferriki.ShikiTransformer = shikiTransformer;

declare const shikiEngine: Shiki.HighlighterCoreOptions["engine"];
// @ts-expect-error Ferriki fixes the native engine; Shiki engine injection is removed.
const removedEngineInput: Ferriki.HighlighterSyncOptions = { engine: shikiEngine };
// @ts-expect-error Shiki's warning toggle is not a Ferriki factory option.
const unsupportedWarnings: Ferriki.HighlighterOptions = { warnings: false };

void shikiToken;
void ferrikiTokenValue;
void ferrikiHighlightOptions;
void ferrikiUndefinedThemeOption;
void ferrikiNamedShikiThemeOption;
void unsupportedUnnamedShikiTheme;
void ferrikiStringTabindex;
void unsupportedWhitespaceMode;
void unsupportedGrammarContextCode;
void unsupportedColorsRendering;
void ferrikiAsyncFactoryOptions;
void ferrikiSyncFactoryOptions;
void ferrikiTokenHook;
void ferrikiContextSource;
void shikiContextSource;
void ferrikiContextTokens;
void shikiContextTokens;
void ferrikiMetaTransformer;
void ferrikiCallbackOnlyDataOptions;
void ferrikiDataTransformer;
void ferrikiDecorationWithoutTransform;
void incompatibleFerrikiDecoration;
void incompatibleShikiHast;
void incompatibleFerrikiTransformer;
void removedEngineInput;
void unsupportedWarnings;
