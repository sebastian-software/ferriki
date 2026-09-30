// A typed order pipeline, including Unicode and HTML-sensitive text.
export interface Order {
  id: string;
  customer: string;
  items: readonly { sku: string; quantity: number; price: number }[];
  status: "pending" | "paid" | "shipped";
}

export type Summary = Pick<Order, "id" | "customer"> & { total: number };
const currency = new Intl.NumberFormat("en", { style: "currency", currency: "EUR" });

export async function summarize(orders: AsyncIterable<Order>): Promise<Summary[]> {
  const summaries: Summary[] = [];
  for await (const order of orders) {
    if (order.status !== "paid") continue;
    const total = order.items.reduce((sum, { quantity, price }) => sum + quantity * price, 0);
    summaries.push({ id: order.id, customer: order.customer, total });
  }
  return summaries.sort((a, b) => b.total - a.total);
}

export function label(order: Summary): string {
  const safeName = order.customer.replace(/[<>&]/g, "_");
  return `${safeName}: ${currency.format(order.total)}`;
}

const demo: Order = {
  id: "ORD-0042",
  customer: "München <team> & café",
  items: [{ sku: "BOOK-α", quantity: 2, price: 19.95 }],
  status: "paid",
};
console.warn(label({ ...demo, total: 39.9 }));
