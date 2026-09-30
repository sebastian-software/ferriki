import process from "node:process";

/** Parse order lines and aggregate integer cents. */
export class OrderError extends Error {
  constructor(line, number) {
    super(`Invalid order on line ${number}: ${JSON.stringify(line)}`);
    this.name = "OrderError";
  }
}

const ORDER_LINE = /^(?<name>[\p{L} .'-]+):\s*(?<amount>\d+)\.(?<fraction>\d{2})$/u;

export function parseOrders(source) {
  return source.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim() || line.startsWith("#")) return [];
    const match = ORDER_LINE.exec(line);
    if (!match) throw new OrderError(line, index + 1);
    const { name, amount, fraction } = match.groups;
    return [{ customer: name, cents: Number(amount) * 100 + Number(fraction) }];
  });
}

export function summarize(orders) {
  const totals = new Map();
  for (const { customer, cents, completed = true } of orders) {
    if (completed) totals.set(customer, (totals.get(customer) ?? 0) + cents);
  }
  return [...totals].sort(([, a], [, b]) => b - a);
}

const source = `Zoë: 12.50
Ada: 19.95
Zoë: 7.50`;
for (const [name, cents] of summarize(parseOrders(source))) {
  process.stdout.write(`<total customer="${name}">€${(cents / 100).toFixed(2)}</total>\n`);
}
