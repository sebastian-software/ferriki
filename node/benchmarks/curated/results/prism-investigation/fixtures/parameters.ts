function greet(name: string): string {
  return name;
}

export function labelOrder(order: { customer: string; total: number }): string {
  return `${order.customer}: €${order.total.toFixed(2)}`;
}
