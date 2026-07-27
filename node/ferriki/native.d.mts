export interface FerrikiNativeHighlighter {
  loadStandardTheme(themeId: string): boolean
  loadStandardGrammar(language: string): string | undefined
  resolveGrammarScope(language: string): string | undefined
  getLoadedGrammarScopes(): string[]
  getLoadedLanguages(): string[]
  codeToTokens(code: string, optionsJson: string): string
  codeToHast(code: string, optionsJson: string): string
  codeToHtml(code: string, optionsJson: string): string
  dispose(): void
}

export interface FerrikiNativeBinding {
  ferrikiVersion(): string
  createHighlighter(optionsJson: string): FerrikiNativeHighlighter
  FerrikiHighlighter: abstract new (...args: never[]) => FerrikiNativeHighlighter
}

export declare function loadFerrikiNativeBinding(): FerrikiNativeBinding
export declare function tryLoadFerrikiNativeBinding(): FerrikiNativeBinding | undefined
