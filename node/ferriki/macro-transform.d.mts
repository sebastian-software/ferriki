export interface InlineCodeMacroCall {
  /** UTF-8 byte offsets in the original source. */
  readonly start: number;
  /** UTF-8 byte offsets in the original source. */
  readonly end: number;
  readonly code: string;
  readonly language: string;
  readonly meta?: string | null;
  readonly lineNumbers?: boolean | null;
  /** Present only for the React `Code` macro. */
  readonly kind?: "react";
  /** Canonical JSX component name, when explicitly provided. */
  readonly component?: string;
}

export interface InlineCodeMacroImport {
  /** UTF-8 byte offsets in the original source. */
  readonly start: number;
  /** UTF-8 byte offsets in the original source. */
  readonly end: number;
  /** Empty for macro-only imports, or a retained `import type` declaration. */
  readonly replacement: string;
}

export interface InlineCodeMacroPlan {
  readonly calls: readonly InlineCodeMacroCall[];
  readonly imports: readonly InlineCodeMacroImport[];
}

/** Node-only build-time bridge to Ferriki's native scope-aware source scanner. */
export declare function findInlineCodeMacros(
  source: string,
  filename?: string,
): InlineCodeMacroPlan;
