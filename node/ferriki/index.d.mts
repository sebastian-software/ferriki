/**
 * Hand-maintained type surface for the ferriki package.
 *
 * The core highlighting API is typed precisely. Everything else is exported
 * with provisional loose types so imports resolve; those signatures will
 * tighten as the TypeScript source of the Node layer is restored.
 */

// ─── Core data shapes ────────────────────────────────────────────────────────

export type BundledLanguage = string
export type BundledTheme = string
export type SpecialLanguage = 'text' | 'plain' | 'plaintext' | 'txt' | 'ansi'
export type SpecialTheme = 'none'

export interface ThemedToken {
  content: string
  offset: number
  color?: string
  bgColor?: string
  fontStyle?: number
  htmlStyle?: Record<string, string>
  variants?: Record<string, { color?: string, fontStyle?: number }>
  [key: string]: unknown
}

export interface TokensResult {
  tokens: ThemedToken[][]
  fg?: string
  bg?: string
  themeName?: string
  rootStyle?: string
  grammarState?: unknown
}

/** hast root node produced by codeToHast. */
export interface HastRoot {
  type: 'root'
  children: HastNode[]
  [key: string]: unknown
}

export interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
  value?: string
  [key: string]: unknown
}

export interface DecorationItem {
  start: number | { line: number, character: number }
  end: number | { line: number, character: number }
  properties?: Record<string, unknown>
  alwaysWrap?: boolean
  [key: string]: unknown
}

export interface CodeOptionsSingleTheme {
  theme: BundledTheme | Record<string, unknown>
}

export interface CodeOptionsMultipleThemes {
  themes: Record<string, BundledTheme | Record<string, unknown>>
  defaultColor?: string | false
  cssVariablePrefix?: string
}

export type CodeToHastOptions = {
  lang: BundledLanguage | SpecialLanguage
  transformers?: unknown[]
  decorations?: DecorationItem[]
  colorReplacements?: Record<string, string | Record<string, string>>
  mergeWhitespaces?: boolean | 'never'
  mergeSameStyleTokens?: boolean
  structure?: 'classic' | 'inline'
  tabindex?: number | string | false
  grammarState?: unknown
  grammarContextCode?: string
  [key: string]: unknown
} & (CodeOptionsSingleTheme | CodeOptionsMultipleThemes)

export type CodeToTokensOptions = {
  lang: BundledLanguage | SpecialLanguage
  includeExplanation?: boolean | 'scopeName'
  grammarState?: unknown
  grammarContextCode?: string
  [key: string]: unknown
} & (CodeOptionsSingleTheme | CodeOptionsMultipleThemes)

// ─── Highlighter ─────────────────────────────────────────────────────────────

export interface HighlighterOptions {
  themes?: (BundledTheme | Record<string, unknown>)[]
  langs?: (BundledLanguage | Record<string, unknown>)[]
  langAlias?: Record<string, string>
  engine?: unknown
  [key: string]: unknown
}

export interface Highlighter {
  codeToHtml: (code: string, options: CodeToHastOptions) => string
  codeToHast: (code: string, options: CodeToHastOptions) => HastRoot
  codeToTokens: (code: string, options: CodeToTokensOptions) => TokensResult
  codeToTokensBase: (code: string, options: Record<string, unknown>) => ThemedToken[][]
  codeToTokensWithThemes: (code: string, options: Record<string, unknown>) => unknown
  loadLanguage: (...langs: (BundledLanguage | Record<string, unknown>)[]) => Promise<void>
  loadTheme: (...themes: (BundledTheme | Record<string, unknown>)[]) => Promise<void>
  getLoadedLanguages: () => string[]
  getLoadedThemes: () => string[]
  getTheme: (name: string) => Record<string, unknown>
  getLanguage: (name: string) => unknown
  setTheme: (name: string) => void
  getLastGrammarState: (...args: unknown[]) => unknown
  dispose: () => void
  [key: string]: unknown
}

// ─── Core highlighting API ───────────────────────────────────────────────────

export declare function codeToHtml(code: string, options: CodeToHastOptions): Promise<string>
export declare function codeToHast(code: string, options: CodeToHastOptions): Promise<HastRoot>
export declare function codeToTokens(code: string, options: CodeToTokensOptions): Promise<TokensResult>
export declare function codeToTokensBase(code: string, options: Record<string, unknown>): Promise<ThemedToken[][]>
export declare function codeToTokensWithThemes(code: string, options: Record<string, unknown>): Promise<unknown>

export declare function createHighlighter(options?: HighlighterOptions): Promise<Highlighter>
export declare function getSingletonHighlighter(options?: HighlighterOptions): Promise<Highlighter>
export declare function getLastGrammarState(...args: unknown[]): unknown

// ─── Ferriki-specific backend API ────────────────────────────────────────────

/** Which backend the current process requested via SHIKI_BACKEND. */
export declare function getRequestedBackend(): 'rust' | 'js'
/** Whether the native Rust addon could be loaded on this platform. */
export declare function isRustBackendAvailable(): boolean
/** Version string reported by the native addon, if available. */
export declare function getFerrikiVersion(): string | undefined
/** Like createHighlighter, but honors SHIKI_BACKEND=rust by pairing the highlighter with the native core. */
export declare function createHighlighterWithBackend(options?: HighlighterOptions): Promise<Highlighter>
export declare function getFerrikiNativeHandle(highlighter: unknown): unknown
export declare const kFerrikiNative: unique symbol
export declare const kFerrikiNativeHandle: unique symbol

// ─── Bundled catalogs ────────────────────────────────────────────────────────

export interface BundledLanguageInfo {
  id: string
  name: string
  aliases?: string[]
  import: () => Promise<unknown>
}

export interface BundledThemeInfo {
  id: string
  displayName: string
  type: 'light' | 'dark'
  import: () => Promise<unknown>
}

export declare const bundledLanguagesInfo: BundledLanguageInfo[]
export declare const bundledLanguagesBase: Record<string, () => Promise<unknown>>
export declare const bundledLanguagesAlias: Record<string, () => Promise<unknown>>
export declare const bundledLanguages: Record<string, () => Promise<unknown>>
export declare const bundledThemesInfo: BundledThemeInfo[]
export declare const bundledThemes: Record<string, () => Promise<unknown>>

// ─── Errors ──────────────────────────────────────────────────────────────────

export declare class ShikiError extends Error {}

// ─── Provisional exports (loose types, signatures to be tightened) ──────────

export declare function addClassToHast(...args: any[]): any
export declare function applyColorReplacements(...args: any[]): any
export declare function createBundledHighlighter(...args: any[]): any
export declare function createCssVariablesTheme(...args: any[]): any
export declare function createHighlighterCore(...args: any[]): any
export declare function createHighlighterCoreSync(...args: any[]): any
export declare function createJavaScriptRegexEngine(...args: any[]): any
export declare function createOnigurumaEngine(...args: any[]): any
export declare function createPositionConverter(...args: any[]): any
export declare function createShikiInternal(...args: any[]): any
export declare function createShikiInternalSync(...args: any[]): any
export declare function createSingletonShorthands(...args: any[]): any
export declare function createdBundledHighlighter(...args: any[]): any
export declare const defaultJavaScriptRegexConstructor: any
export declare function enableDeprecationWarnings(...args: any[]): any
export declare function flatTokenVariants(...args: any[]): any
export declare function getSingletonHighlighterCore(...args: any[]): any
export declare function getTokenStyleObject(...args: any[]): any
export declare function guessEmbeddedLanguages(...args: any[]): any
export declare function hastToHtml(...args: any[]): any
export declare function isNoneTheme(...args: any[]): boolean
export declare function isPlainLang(...args: any[]): boolean
export declare function isSpecialLang(...args: any[]): boolean
export declare function isSpecialTheme(...args: any[]): boolean
export declare function loadWasm(...args: any[]): any
export declare function makeSingletonHighlighter(...args: any[]): any
export declare function makeSingletonHighlighterCore(...args: any[]): any
export declare function normalizeGetter(...args: any[]): any
export declare function normalizeTheme(...args: any[]): any
export declare function resolveColorReplacements(...args: any[]): any
export declare function splitLines(...args: any[]): any
export declare function splitToken(...args: any[]): any
export declare function splitTokens(...args: any[]): any
export declare function stringifyTokenStyle(...args: any[]): any
export declare function toArray<T>(value: T | T[]): T[]
export declare function tokenizeAnsiWithTheme(...args: any[]): any
export declare function tokenizeWithTheme(...args: any[]): any
export declare function tokensToHast(...args: any[]): any
export declare const transformerDecorations: any
export declare function warnDeprecated(...args: any[]): any
