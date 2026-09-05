export interface LanguageRegistration {
  name: string
  scopeName: string
  displayName?: string
  aliases?: readonly string[]
  patterns?: readonly unknown[]
  repository?: Readonly<Record<string, unknown>>
  injections?: Readonly<Record<string, unknown>>
  injectionSelector?: string
  fileTypes?: readonly string[]
  firstLineMatch?: string
  embeddedLangs?: readonly string[]
  embeddedLanguages?: readonly string[]
  embeddedLangsLazy?: readonly string[]
  injectTo?: readonly string[]
  balancedBracketSelectors?: readonly string[]
  unbalancedBracketSelectors?: readonly string[]
  foldingStopMarker?: string
  foldingStartMarker?: string
}

export interface ThemeRegistration {
  name: string
  type?: 'dark' | 'light' | string
  fg?: string
  bg?: string
  settings?: readonly unknown[]
  tokenColors?: readonly unknown[]
  colors?: Readonly<Record<string, string>>
  include?: string
  displayName?: string
  $schema?: string
  semanticHighlighting?: boolean
  semanticTokenColors?: Readonly<Record<string, string>>
}

export type LanguageInput = string | LanguageRegistration
export type ThemeInput = string | ThemeRegistration
export type SyncRegistrationInput<T>
  = | T
    | { default: SyncRegistrationInput<T> }
    | readonly SyncRegistrationInput<T>[]
export type RegistrationInput<T>
  = | SyncRegistrationInput<T>
    | PromiseLike<RegistrationInput<T>>
    | (() => RegistrationInput<T>)

export interface HighlighterOptions {
  langs?: readonly RegistrationInput<LanguageInput>[]
  themes?: readonly RegistrationInput<ThemeInput>[]
  langAlias?: Readonly<Record<string, string>>
  transformers?: readonly ShikiTransformer[]
}

export interface HighlighterSyncOptions {
  langs?: readonly SyncRegistrationInput<LanguageInput>[]
  themes?: readonly SyncRegistrationInput<ThemeInput>[]
  langAlias?: Readonly<Record<string, string>>
  transformers?: readonly ShikiTransformer[]
}

export interface HighlightOptions {
  lang: LanguageInput
  theme?: ThemeInput
  themes?: Readonly<Record<string, ThemeInput>>
  defaultColor?: string | false
  cssVariablePrefix?: string
  includeExplanation?: boolean | 'scopeName' | 'tokenType'
  grammarState?: GrammarState
  mergeWhitespaces?: boolean
  mergeSameStyleTokens?: boolean
  rootStyle?: string | false
  tabindex?: string | number | false | null
  tokenizeMaxLineLength?: number
  tokenizeTimeLimit?: number
  structure?: 'classic' | 'inline'
  meta?: Readonly<Record<string, unknown>>
  data?: Readonly<Record<string, unknown>>
  transformers?: readonly ShikiTransformer[]
  decorations?: readonly DecorationItem[]
}

export interface ThemedToken {
  content: string
  offset: number
  htmlAttrs?: Readonly<Record<string, string>>
  color?: string
  fontStyle?: number
  type?: number
  htmlStyle?: Readonly<Record<string, string>>
  variants?: Readonly<Record<string, {
    color?: string
    fontStyle?: number
  }>>
  explanation?: readonly ThemedTokenExplanation[]
}

export interface ThemedTokenScopeExplanation {
  scopeName: string
}

export interface ThemedTokenExplanation {
  content: string
  scopes: readonly ThemedTokenScopeExplanation[]
}

export interface GrammarState {
  readonly version: 1
  readonly lang: string
  readonly theme: string
  readonly themes: readonly string[]
  readonly scopes: readonly string[]
  /** Opaque serialized source context used to continue tokenization. */
  readonly source: string
}

export interface TokensResult {
  tokens: ThemedToken[][]
  fg: string
  bg: string
  themeName: string
  rootStyle?: string
  grammarState?: GrammarState
}

export interface HastText {
  type: 'text'
  value: string
}

export interface HastElement {
  type: 'element'
  tagName: string
  properties: Record<string, unknown>
  children: HastNode[]
}

export interface HastRoot {
  type: 'root'
  children: HastNode[]
}

export type HastNode = HastRoot | HastElement | HastText

export interface DecorationItem {
  start: number | { line: number, character: number }
  end: number | { line: number, character: number }
  tagName?: string
  properties?: Record<string, unknown>
  transform?: (element: HastElement, type: 'wrapper' | 'line' | 'token') => HastElement | void
  alwaysWrap?: boolean
}

export interface ShikiTransformerContextCommon {
  meta: Record<string, unknown>
  options: HighlightOptions
  codeToHast: (code: string, options: HighlightOptions) => HastRoot
  codeToTokens: (code: string, options: HighlightOptions) => TokensResult
}

export interface ShikiTransformerContext extends ShikiTransformerContextCommon {
  readonly source: string
  readonly tokens: ThemedToken[][]
  readonly root: HastRoot
  readonly pre: HastElement
  readonly code: HastElement
  readonly lines: HastElement[]
  readonly structure: HighlightOptions['structure']
  addClassToHast: (hast: HastElement, className: string | string[]) => HastElement
}

export interface ShikiTransformer {
  name?: string
  enforce?: 'pre' | 'post'
  preprocess?: (this: ShikiTransformerContextCommon, code: string, options: HighlightOptions) => string | void
  tokens?: (this: ShikiTransformerContextCommon & { readonly source: string }, tokens: ThemedToken[][]) => ThemedToken[][] | void
  root?: (this: ShikiTransformerContext, hast: HastRoot) => HastRoot | void
  pre?: (this: ShikiTransformerContext, hast: HastElement) => HastElement | void
  code?: (this: ShikiTransformerContext, hast: HastElement) => HastElement | void
  line?: (this: ShikiTransformerContext, hast: HastElement, line: number) => HastElement | void
  span?: (this: ShikiTransformerContext, hast: HastElement, line: number, col: number, lineElement: HastElement, token: ThemedToken) => HastElement | void
  postprocess?: (this: ShikiTransformerContextCommon, html: string, options: HighlightOptions) => string | void
}

export interface Highlighter {
  codeToHtml: (code: string, options: HighlightOptions) => string
  codeToHast: (code: string, options: HighlightOptions) => HastRoot
  codeToTokens: (code: string, options: HighlightOptions) => TokensResult
  codeToTokensBase: (code: string, options: HighlightOptions) => ThemedToken[][]
  codeToTokensWithThemes: (code: string, options: HighlightOptions) => ThemedToken[][]
  getLastGrammarState: {
    (code: string, options: HighlightOptions): GrammarState
    (element: ThemedToken[][] | HastRoot): GrammarState | undefined
  }
  getLoadedLanguages: () => string[]
  getLoadedThemes: () => string[]
  loadLanguage: (...languages: RegistrationInput<LanguageInput>[]) => Promise<void>
  loadLanguageSync: (...languages: SyncRegistrationInput<LanguageInput>[]) => void
  loadTheme: (...themes: RegistrationInput<ThemeInput>[]) => Promise<void>
  loadThemeSync: (...themes: SyncRegistrationInput<ThemeInput>[]) => void
  resolveLangAlias: (language: string) => string
  dispose: () => void
  [Symbol.dispose]: () => void
}

export type FerrikiErrorCode
  = | 'ERR_USAGE'
    | 'ERR_UNSUPPORTED'
    | 'ERR_NATIVE_LOAD'
    | 'ERR_ASSET'
    | 'ERR_RESOURCE_LIMIT'
    | 'ERR_INTERNAL'

export declare class ShikiError extends Error {
  readonly code: FerrikiErrorCode
  constructor(message: string, code?: FerrikiErrorCode, options?: { cause?: unknown })
}

export declare class FerrikiError extends ShikiError {
  constructor(message: string, code?: FerrikiErrorCode, options?: { cause?: unknown })
}

/** Version of the bundled native core, or undefined when no platform binary loads. */
export declare function ferrikiVersion(): string | undefined

export declare function createHighlighter(options?: HighlighterOptions): Promise<Highlighter>
export declare const createHighlighterCore: typeof createHighlighter
export declare const createShikiPrimitiveAsync: typeof createHighlighter
export declare function createHighlighterCoreSync(options?: HighlighterSyncOptions): Highlighter
export declare function createShikiPrimitive(options?: HighlighterSyncOptions): Highlighter

export declare function getSingletonHighlighter(options?: HighlighterOptions): Promise<Highlighter>
export declare const getSingletonHighlighterCore: typeof getSingletonHighlighter

export declare function codeToHtml(code: string, options: HighlightOptions): Promise<string>
export declare function codeToHtml(
  highlighter: Highlighter,
  code: string,
  options: HighlightOptions,
): string

export declare function codeToHast(code: string, options: HighlightOptions): Promise<HastRoot>
export declare function codeToHast(
  highlighter: Highlighter,
  code: string,
  options: HighlightOptions,
): HastRoot

export declare function codeToTokens(code: string, options: HighlightOptions): Promise<TokensResult>
export declare function codeToTokens(
  highlighter: Highlighter,
  code: string,
  options: HighlightOptions,
): TokensResult

export declare function codeToTokensBase(
  code: string,
  options: HighlightOptions,
): Promise<ThemedToken[][]>
export declare function codeToTokensBase(
  highlighter: Highlighter,
  code: string,
  options: HighlightOptions,
): ThemedToken[][]

export declare function codeToTokensWithThemes(
  code: string,
  options: HighlightOptions,
): Promise<ThemedToken[][]>
export declare function codeToTokensWithThemes(
  highlighter: Highlighter,
  code: string,
  options: HighlightOptions,
): ThemedToken[][]

export declare function getLastGrammarState(
  code: string,
  options: HighlightOptions,
): Promise<GrammarState>
export declare function getLastGrammarState(
  highlighter: Highlighter,
  code: string,
  options: HighlightOptions,
): GrammarState
export declare function getLastGrammarState(
  highlighter: Highlighter,
  element: ThemedToken[][] | HastRoot,
): GrammarState | undefined

export interface CssVariablesThemeOptions {
  name?: string
  type?: 'dark' | 'light' | string
  variableDefaults?: {
    foreground?: string
    background?: string
  }
}

export declare function createCssVariablesTheme(
  options?: CssVariablesThemeOptions,
): ThemeRegistration
export declare function hastToHtml(tree: HastRoot | HastElement): string

export declare const bundledLanguages: Readonly<
  Record<string, () => Promise<LanguageRegistration[]>>
>
export declare const bundledThemes: Readonly<
  Record<string, () => Promise<ThemeRegistration>>
>
export declare const bundledLanguagesAlias: Readonly<Record<string, string>>
export type BundledLanguage = keyof typeof bundledLanguages
export type BundledTheme = keyof typeof bundledThemes
