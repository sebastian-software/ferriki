import { useMDXComponents as useArdoMDXComponents } from "ardo/mdx-provider";

import { FocusablePre } from "./focusable-pre.tsx";
import { FocusableTable } from "./focusable-table.tsx";

export function useMDXComponents() {
  const components = useArdoMDXComponents();

  return {
    ...components,
    pre: FocusablePre,
    table: FocusableTable,
  };
}
