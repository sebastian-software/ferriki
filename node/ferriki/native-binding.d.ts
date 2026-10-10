// Generated from ferriki-core Rust bindings. Do not edit.

export declare class FerrikiHighlighter {
  loadStandardTheme(themeId: string): boolean;
  loadStandardGrammar(language: string): string | null;
  loadCustomGrammar(registrationJson: string): string | null;
  loadCustomTheme(registrationJson: string): boolean;
  resolveGrammarScope(language: string): string | null;
  getLoadedGrammarScopes(): Array<string>;
  getLoadedLanguages(): Array<string>;
  getHtmlRenderData(code: string, options: NativeTokenOptions): HtmlRenderData;
  getHtmlRenderDataWithThemes(code: string, options: NativeTokenOptions): HtmlRenderDataWithThemes;
  codeToHtml(code: string, options: NativeHighlightOptions): string;
  /** Plans missing standard payloads for Node to fetch and install. */
  planAssets(languages: Array<string>, themes: Array<string>): Promise<Array<AssetPlanEntry>>;
  assetCacheDir(): string | null;
  dispose(): void;
}

export interface AssetPlanEntry {
  path: string;
  digest: string;
  size: number;
  url: string;
}

export declare function createHighlighter(options: NativeHighlighterOptions): FerrikiHighlighter;

export declare function ferrikiVersion(): string;

export interface HtmlRenderData {
  tokens: Array<Array<HtmlToken>>;
  fg: string;
  bg: string;
  themeName: string;
}

export interface HtmlRenderDataWithThemes {
  tokens: Array<Array<HtmlThemeToken>>;
  themes: Array<ThemeMetadata>;
}

export interface HtmlThemeToken {
  content: string;
  offset: number;
  variants: Record<string, ThemeTokenStyle>;
  type?: number;
  scopeNames?: Array<string>;
}

export interface HtmlToken {
  content: string;
  offset: number;
  color?: string;
  fontStyle?: number;
  type?: number;
  scopeNames?: Array<string>;
}

export interface NativeAssetOptions {
  remote?: boolean;
  baseUrl?: string;
  cacheDir?: string;
}

export interface NativeHighlighterOptions {
  standardAssetRoot?: string;
  assets?: NativeAssetOptions;
  regexPrefilter?: boolean;
}

export interface NativeHighlightOptions {
  lang: string;
  theme: string;
  includeExplanation?: string | boolean;
  tokenizeTimeLimit?: number;
  tokenizeMaxLineLength?: number;
  mergeWhitespaces?: boolean;
  mergeSameStyleTokens?: boolean;
  rootStyle?: string | boolean;
  tabindex?: string | boolean;
  styleMode?: string;
  themeEntries?: Array<ThemeEntry>;
}

export interface NativeTokenOptions {
  lang: string;
  theme: string;
  includeExplanation?: string | boolean;
  tokenizeTimeLimit?: number;
  tokenizeMaxLineLength?: number;
  styleMode?: string;
  themeEntries?: Array<ThemeEntry>;
}

export interface ThemeEntry {
  color: string;
  name: string;
}

export interface ThemeMetadata {
  color: string;
  name: string;
  foreground: string;
  background: string;
}

export interface ThemeTokenStyle {
  color?: string;
  fontStyle?: number;
}
