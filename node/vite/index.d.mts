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
  /** Add line-number data and the plugin's line-number stylesheet. */
  lineNumbers?: boolean;
  /** JavaScript callbacks forwarded to Ferriki's existing per-block transformer pipeline. */
  transformers?: readonly ShikiTransformer[];
  /** Include an additional compiler-emitted JSX module ID, such as an MDX intermediate. */
  include?: (id: string) => boolean;
};

/** Highlight opted-in HTML and static JSX code blocks during Vite transforms. */
export declare function ferriki(options?: FerrikiViteOptions): Plugin;
