export interface LanguageRegistration {
  name: string
  id?: string
  scopeName?: string
  aliases?: readonly string[]
  [key: string]: unknown
}

export interface ThemeRegistration {
  name: string
  type?: 'dark' | 'light' | string
  fg?: string
  bg?: string
  settings?: readonly unknown[]
  [key: string]: unknown
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
  [key: string]: unknown
}

export interface HighlighterSyncOptions {
  langs?: readonly SyncRegistrationInput<LanguageInput>[]
  themes?: readonly SyncRegistrationInput<ThemeInput>[]
  langAlias?: Readonly<Record<string, string>>
  [key: string]: unknown
}

export interface HighlightOptions {
  lang: LanguageInput
  theme?: ThemeInput
  themes?: Readonly<Record<string, ThemeInput>>
  defaultColor?: string | false
  cssVariablePrefix?: string
  includeExplanation?: boolean | 'scopeName' | 'tokenType'
  mergeWhitespaces?: boolean
  mergeSameStyleTokens?: boolean
  rootStyle?: string | false
  tabindex?: string | number | false | null
  tokenizeMaxLineLength?: number
  tokenizeTimeLimit?: number
  [key: string]: unknown
}

export interface ThemedToken {
  content: string
  offset: number
  color?: string
  fontStyle?: number
  type?: number
  htmlStyle?: Readonly<Record<string, string>>
  variants?: Readonly<Record<string, {
    color?: string
    fontStyle?: number
  }>>
}

export interface TokensResult {
  tokens: ThemedToken[][]
  fg: string
  bg: string
  themeName: string
  rootStyle?: string
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

export interface Highlighter {
  codeToHtml: (code: string, options: HighlightOptions) => string
  codeToHast: (code: string, options: HighlightOptions) => HastRoot
  codeToTokens: (code: string, options: HighlightOptions) => TokensResult
  codeToTokensBase: (code: string, options: HighlightOptions) => ThemedToken[][]
  codeToTokensWithThemes: (code: string, options: HighlightOptions) => ThemedToken[][]
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

export declare class ShikiError extends Error {
  constructor(message: string)
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

export declare function getLastGrammarState(): undefined

export interface RegexEngine {}
export declare function createJavaScriptRegexEngine(): RegexEngine
export declare function createOnigurumaEngine(): RegexEngine
export declare function loadWasm(): Promise<void>
export declare const wasmBinary: Uint8Array

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
