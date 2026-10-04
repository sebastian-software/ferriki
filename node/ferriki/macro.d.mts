export interface FerrikiCodeOptions {
  readonly language: string;
  readonly meta?: string;
  readonly lineNumbers?: boolean;
}

export interface PreparedCodeBlock {
  readonly code: string;
  readonly language: string;
  /** The complete rendered `<pre><code>…</code></pre>` fragment. */
  readonly html: string;
  /** Generated theme CSS and adapter line-number/highlight rules. */
  readonly css: string;
  readonly metadata: Readonly<{
    title?: string;
    label?: string;
    lineNumbers: boolean;
    highlightedLines: readonly number[];
  }>;
}

/**
 * Compile-time macro for preparing static source as Ferriki HTML and CSS.
 * Calls must be transformed by `@ferriki/vite` before browser execution.
 */
export declare function code(source: string, options: FerrikiCodeOptions): PreparedCodeBlock;
