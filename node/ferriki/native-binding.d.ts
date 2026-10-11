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

export declare function decorationSections(
  source: string,
  input: Array<NativeDecorationRange>,
): NativeDecorationPreparation;

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

export interface NativeDecorationContinuation {
  section: NativeDecorationSection;
  cursor: NativeDecorationCursor;
}

export interface NativeDecorationCursor {
  /** 0 = start, 1 = after start, 2 = middle, 3 = done. */
  phase: number;
  line: number;
}

export interface NativeDecorationMutation {
  decoration: number;
  node: number;
  line: number;
  start: number;
  count: number;
  target: string;
}

export interface NativeDecorationPlan {
  mutations: Array<NativeDecorationMutation>;
  error?: string;
}

export interface NativeDecorationPosition {
  line: number;
  character: number;
  offset: number;
}

export interface NativeDecorationPreparation {
  ranges: Array<NativeResolvedDecoration>;
  sections: Array<NativeDecorationSection>;
}

export interface NativeDecorationRange {
  startOffset?: number;
  startLine?: number;
  startCharacter?: number;
  endOffset?: number;
  endLine?: number;
  endCharacter?: number;
  alwaysWrap: boolean;
}

export interface NativeDecorationSection {
  decoration: number;
  line: number;
  start: number;
  end?: number;
  wholeLine: boolean;
  alwaysWrap: boolean;
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

export interface NativeResolvedDecoration {
  start: NativeDecorationPosition;
  end: NativeDecorationPosition;
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

export declare function nextDecorationSection(
  range: NativeResolvedDecoration,
  decoration: number,
  alwaysWrap: boolean,
  cursor: NativeDecorationCursor,
): NativeDecorationContinuation | null;

export declare function planDecorationMutations(
  input: Float64Array,
  lines: Array<number>,
  sections: Array<NativeDecorationSection>,
): NativeDecorationPlan;

export declare function splitDecorationTokens(
  source: string,
  input: Array<NativeDecorationRange>,
  lines: Array<Float64Array>,
): Array<Uint32Array>;

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
