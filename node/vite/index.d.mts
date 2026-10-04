import type { AssetOptions, ShikiTransformer } from "@ferriki/core";
import type { Plugin } from "vite";

export type FerrikiViteOptions = {
  /** Theme name for inline output. Defaults to `github-dark-default`. */
  theme?: string;
  /** Named theme map for light/dark or other theme-variable output. */
  themes?: Readonly<Record<string, string>>;
  /** Asset source and cache settings passed to the native highlighter. */
  assets?: AssetOptions;
  /** Inline styles by default; `classes` emits a CSS virtual module. */
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

/**
 * Prepare `code()` calls from `@ferriki/core/macro` and `<Code />` elements from
 * `@ferriki/core/react/macro` as highlighted HTML and CSS during Vite transforms.
 */
export declare function ferriki(options?: FerrikiViteOptions): Plugin;
