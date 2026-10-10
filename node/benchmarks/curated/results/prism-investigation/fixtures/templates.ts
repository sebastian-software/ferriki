interface Customer {
  name: string;
  tags: readonly string[];
}

export function describe<T extends Customer>(customer: T, prefix = "Order") {
  // A multiline comment checks comment state across a line break.
  const summary = `\n${prefix}: ${customer.name.toUpperCase()}\n`;
  return `${summary}${customer.tags.map((tag) => `#${tag}`).join(" ")}`;
}
