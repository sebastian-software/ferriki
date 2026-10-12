export interface CodeElementRegistrationOptions {
  /** Add custom CSS to the local style in each shadow root. */
  readonly css?: string;
  /** Add the shared class-palette stylesheet to new shadow roots. */
  readonly stylesheetHref?: string;
  readonly themeAliases?: readonly string[];
  /** Trusted HTML indexed by code-ref ID for browser resolution. */
  readonly blocks?: Readonly<Record<string, string>>;
}

export interface CodeElementSizingStyle {
  readonly display: "block";
  readonly boxSizing: "content-box";
  readonly minBlockSize: string;
  readonly ["--ferriki-code-max-block-size"]?: string;
}

export interface FerrikiCodeElement extends HTMLElement {
  /** Trusted Ferriki-generated HTML rendered inside the element's shadow root. */
  highlightedCode: string | null | undefined;
  /** Code-ref registry key used to resolve trusted HTML, when present. */
  codeRef: string | null | undefined;
  /** Maximum visible code lines, or undefined when the code pane is uncapped. */
  maxLines: number | null | undefined;
}

export declare const FERRIKI_CODE_TAG: "ferriki-code";

/** Reserve host height for a positive build-time code line count, optionally capped. */
export declare function codeElementSizing(
  lineCount: number,
  maxLines?: number,
): CodeElementSizingStyle;

/** Generate local base, line annotation, and theme-switch CSS for the provided aliases. */
export declare function codeElementStyles(themeAliases?: readonly string[]): string;

/**
 * Define `<ferriki-code>` and register custom local CSS, an optional shared
 * stylesheet URL, and trusted HTML blocks. Returns `undefined` in SSR.
 */
export declare function defineCodeElement(
  options?: CodeElementRegistrationOptions,
): (new () => FerrikiCodeElement) | undefined;
