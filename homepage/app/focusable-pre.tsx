import type { ComponentProps, ElementType } from "react";

import { useMDXComponents as useArdoMDXComponents } from "ardo/mdx-provider";

export function FocusablePre(props: ComponentProps<"pre">) {
  const components = useArdoMDXComponents() as Partial<Record<"pre", ElementType>>;
  const Pre = components.pre ?? "pre";
  return <Pre {...props} tabIndex={props.tabIndex ?? 0} />;
}
