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
  /** Original-source presentation expressions, in JSX attribute order. */
  readonly presentation?: readonly InlineCodeMacroPresentationProp[];
}

export interface InlineCodeMacroPresentationProp {
  /** `render` or `className`. */
  readonly name: "render" | "className";
  /** UTF-8 byte offsets in the original source; expression braces are excluded. */
  readonly start: number;
  /** UTF-8 byte offsets in the original source; expression braces are excluded. */
  readonly end: number;
  /** Decoded value only when `className` was supplied as a quoted JSX string. */
  readonly literal?: string;
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
