type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** Make overflowing documentation tables reachable with a keyboard. */
export function rehypeFocusableTables() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (node.type === "element" && node.tagName === "table") {
        node.properties ??= {};
        node.properties.tabIndex = 0;
      }
      for (const child of node.children ?? []) visit(child);
    };

    visit(tree);
  };
}
