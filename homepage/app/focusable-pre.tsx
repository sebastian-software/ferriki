import type { ComponentProps, ElementType } from "react";

import { useMDXComponents as useArdoMDXComponents } from "ardo/mdx-provider";

function isReactElementType(value: unknown): value is ElementType {
  return typeof value === "string" || typeof value === "function";
}

export function FocusablePre(props: ComponentProps<"pre">) {
  const components: unknown = useArdoMDXComponents();
  const candidate =
    typeof components === "object" && components !== null && "pre" in components
      ? components.pre
      : undefined;
  const Pre = isReactElementType(candidate) ? candidate : "pre";
  return <Pre {...props} tabIndex={props.tabIndex ?? 0} />;
}
