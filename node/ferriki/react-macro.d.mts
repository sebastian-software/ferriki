import type { ComponentType, ReactElement } from "react";
import type { FerrikiCodeOptions, PreparedCodeBlock } from "./macro.mjs";

export interface CodeProps extends FerrikiCodeOptions {
  /** Direct string literal or cooked template literal without interpolations. */
  readonly source: string;
  /** Optional presentation component receiving the prepared descriptor as `code`. */
  readonly component?: ComponentType<{ code: PreparedCodeBlock }>;
  readonly children?: never;
}

/** Build-time JSX marker. Configure Ferriki before the React JSX transform. */
export declare function Code(props: CodeProps): ReactElement;
