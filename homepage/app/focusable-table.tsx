import type { ComponentProps } from "react";

export function FocusableTable(props: ComponentProps<"table">) {
  return <table {...props} tabIndex={props.tabIndex ?? 0} />;
}
