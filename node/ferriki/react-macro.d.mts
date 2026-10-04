import type { ReactNode } from "react";
import type { FerrikiCodeOptions, PreparedCodeBlock } from "./macro.mjs";

export interface CodeRenderProps {
  readonly code: PreparedCodeBlock;
  /** Supplied className, for explicit forwarding by the renderer. */
  readonly className?: string | undefined;
}

export interface CodeProps extends FerrikiCodeOptions {
  /** Direct string literal or cooked template literal without interpolations. */
  readonly source: string;
  /** Class for the default div, or a value passed to the optional renderer. */
  readonly className?: string | undefined;
  /** Optional runtime renderer. Source preparation still happens at build time. */
  readonly render?: ((props: CodeRenderProps) => ReactNode) | undefined;
  readonly children?: never;
}

/** Build-time JSX marker. Configure Ferriki before the React JSX transform. */
export declare function Code(props: CodeProps): ReactNode;
