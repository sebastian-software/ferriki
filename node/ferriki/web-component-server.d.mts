/** Options for converting reference-based `<ferriki-code>` hosts to DSD. */
export interface CodeElementShadowsOptions {
  /** Trusted highlighted HTML indexed by safe `code-ref` ID. */
  readonly blocks: Readonly<Record<string, string>>;
  /** Optional stylesheet URL shared by each emitted shadow root. */
  readonly stylesheetHref?: string;
  /** Theme aliases used by the runtime's local theme-switching CSS. Defaults to `light` and `dark`. */
  readonly themeAliases?: readonly string[];
}

/**
 * Add declarative Shadow DOM to eligible hosts in one complete React-rendered
 * HTML string. This is a non-streaming HTML postprocessor, not a sanitizer.
 */
export declare function renderCodeElementShadows(
  markup: string,
  options: CodeElementShadowsOptions,
): string;
