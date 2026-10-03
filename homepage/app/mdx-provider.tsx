import { useMDXComponents as useArdoMDXComponents } from "ardo/mdx-provider";

import { FocusableTable } from "./focusable-table.tsx";

export function useMDXComponents() {
  return {
    ...useArdoMDXComponents(),
    table: FocusableTable,
  };
}
