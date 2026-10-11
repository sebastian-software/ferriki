import type { DetailedHTMLProps, HTMLAttributes, ReactNode } from "react";
import type { FerrikiCodeOptions, PreparedCodeBlock } from "./macro.mjs";
import type { FerrikiCodeElement } from "./web-component.mjs";

export interface CodeRenderProps {
  readonly code: PreparedCodeBlock;
  /** Supplied className, for explicit forwarding by the renderer. */
  readonly className?: string | undefined;
  /** Configured theme alias for the default shadow host, or the custom renderer. */
  readonly theme?: string | undefined;
  /** Maximum visible code lines, for explicit forwarding by the renderer. */
  readonly maxLines?: number | undefined;
}

export interface CodeProps extends FerrikiCodeOptions {
  /** Direct string literal or cooked template literal without interpolations. */
  readonly source: string;
  /** Class for the default ferriki-code host, or a value passed to the renderer. */
  readonly className?: string | undefined;
  /** Optional runtime theme alias from the Vite plugin's themes map. */
  readonly theme?: string | undefined;
  /** Optional positive integer visible-line cap; longer code scrolls vertically. */
  readonly maxLines?: number | undefined;
  /** Optional runtime renderer. Source preparation still happens at build time. */
  readonly render?: ((props: CodeRenderProps) => ReactNode) | undefined;
  readonly children?: never;
}

/** Build-time JSX marker. Configure Ferriki before the React JSX transform. */
export declare function Code(props: CodeProps): ReactNode;

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ferriki-code": DetailedHTMLProps<HTMLAttributes<FerrikiCodeElement>, FerrikiCodeElement> & {
        /** Property for client rendering; use `code-ref` for server-rendered JSX. */
        codeRef?: string | null | undefined;
        "code-ref"?: string | undefined;
        /** Property for client rendering; use `max-lines` for server-rendered JSX. */
        maxLines?: number | null | undefined;
        "max-lines"?: number | string | undefined;
        highlightedCode?: string | null | undefined;
        "highlighted-code"?: string | undefined;
        "data-ferriki-theme"?: string;
      };
    }
  }
}
