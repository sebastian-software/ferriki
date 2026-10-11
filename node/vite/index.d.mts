import type { AssetOptions, ShikiTransformer } from "@ferriki/core";
import type { Plugin } from "vite";

export type FerrikiViteOptions = {
  /** Theme name for inline output. Defaults to `github-dark-default`. */
  theme?: string;
  /** Named theme map; React code elements require CSS-safe ASCII alias keys. */
  themes?: Readonly<Record<string, string>>;
  /** Asset source and cache settings passed to the native highlighter. */
  assets?: AssetOptions;
  /** Inline styles by default; `classes` emits CSS, shared by default React shadow roots. */
  styleMode?: "inline" | "classes";
  /** Default line numbers for macro calls and `Code` elements; each one can override this. */
  lineNumbers?: boolean;
  /** JavaScript callbacks forwarded to Ferriki's existing per-block transformer pipeline. */
  transformers?: readonly ShikiTransformer[];
  /**
   * Also transform a module ID that has no JavaScript or TypeScript extension, such as a
   * compiler-emitted MDX intermediate. Only modules that import a macro specifier are parsed.
   */
  include?: (id: string) => boolean;
};

export type FerrikiViteApi = {
  /** Snapshot of prepared React HTML, suitable for a saved server-side registry. */
  codeElementBlocks(): Readonly<Record<string, string>>;
  /**
   * Fill manually authored empty `ferriki-code` hosts in complete SSR HTML with
   * Declarative Shadow DOM. React Code macros already emit their own templates.
   * Call after rendering; this does not process a stream.
   */
  renderCodeElements(markup: string, options?: { stylesheetHref?: string }): string;
  /**
   * Shared shadow CSS for transformed React macros. The plugin serves/emits it
   * automatically for Code macros; manual `renderCodeElements` consumers can use
   * this snapshot for their own stylesheet endpoint or asset.
   */
  codeElementCss(): string;
};

export type FerrikiVitePlugin = Plugin & { api: FerrikiViteApi };

/**
 * Prepare `code()` calls from `@ferriki/core/macro` and `<Code />` elements from
 * `@ferriki/core/react/macro` as highlighted HTML and CSS during Vite transforms.
 */
export declare function ferriki(options?: FerrikiViteOptions): FerrikiVitePlugin;
