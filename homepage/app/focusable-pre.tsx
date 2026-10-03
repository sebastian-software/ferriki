import type { ComponentProps } from "react";

import { useMDXComponents as useArdoMDXComponents } from "ardo/mdx-provider";

export function FocusablePre(props: ComponentProps<"pre">) {
  const components: Partial<ReturnType<typeof useArdoMDXComponents>> = useArdoMDXComponents();
  const Pre = components.pre ?? "pre";
  return <Pre {...props} tabIndex={props.tabIndex ?? 0} />;
}
