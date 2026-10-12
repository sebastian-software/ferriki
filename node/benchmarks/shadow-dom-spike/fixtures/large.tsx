import { useMemo, useState, type FormEvent, type ReactElement } from "react";

type OrderStatus = "pending" | "paid" | "shipped" | "refunded";
type SortKey = "customer" | "total" | "updatedAt";
type SortDirection = "ascending" | "descending";

interface LineItem {
  sku: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

interface Order {
  id: string;
  customer: { name: string; email: string };
  items: readonly LineItem[];
  status: OrderStatus;
  updatedAt: string;
}

interface OrderBoardProps {
  initialOrders: readonly Order[];
  onOpenOrder: (orderId: string) => void;
  onArchiveOrder: (orderId: string) => void;
}

interface OrderRowProps {
  order: Order;
  onOpen: (orderId: string) => void;
  onArchive: (orderId: string) => void;
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const statusLabel: Record<OrderStatus, string> = {
  pending: "Waiting for payment",
  paid: "Paid",
  shipped: "Shipped",
  refunded: "Refunded",
};

function totalFor(order: Order): number {
  return order.items.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
}

function matchesQuery(order: Order, query: string): boolean {
  if (query.length === 0) return true;
  const normalized = query.trim().toLocaleLowerCase("en-US");
  return [
    order.id,
    order.customer.name,
    order.customer.email,
    ...order.items.map((item) => item.sku),
  ]
    .join(" ")
    .toLocaleLowerCase("en-US")
    .includes(normalized);
}

function compareOrders(left: Order, right: Order, key: SortKey): number {
  if (key === "total") return totalFor(left) - totalFor(right);
  if (key === "updatedAt") return left.updatedAt.localeCompare(right.updatedAt);
  return left.customer.name.localeCompare(right.customer.name, "en-US", { sensitivity: "base" });
}

function sortOrders(orders: readonly Order[], key: SortKey, direction: SortDirection): Order[] {
  const multiplier = direction === "ascending" ? 1 : -1;
  return [...orders].sort((left, right) => multiplier * compareOrders(left, right, key));
}

function OrderRow({ order, onOpen, onArchive }: OrderRowProps): ReactElement {
  const total = totalFor(order);
  return (
    <tr data-order-id={order.id} data-order-status={order.status}>
      <th scope="row">
        <button className="order-link" onClick={() => onOpen(order.id)} type="button">
          <span className="order-customer">{order.customer.name}</span>
          <span className="order-email">{order.customer.email}</span>
        </button>
      </th>
      <td>
        <span className={`status status-${order.status}`}>{statusLabel[order.status]}</span>
      </td>
      <td>{order.items.length} items</td>
      <td>{currency.format(total)}</td>
      <td>
        <time dateTime={order.updatedAt}>
          {new Date(order.updatedAt).toLocaleDateString("en-US")}
        </time>
      </td>
      <td>
        <button
          aria-label={`Archive ${order.id}`}
          onClick={() => onArchive(order.id)}
          type="button"
        >
          Archive
        </button>
      </td>
    </tr>
  );
}

export function OrderBoard({
  initialOrders,
  onOpenOrder,
  onArchiveOrder,
}: OrderBoardProps): ReactElement {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<OrderStatus | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [direction, setDirection] = useState<SortDirection>("descending");

  const visibleOrders = useMemo(() => {
    const filtered = initialOrders.filter(
      (order) => (status === "all" || order.status === status) && matchesQuery(order, query),
    );
    return sortOrders(filtered, sortKey, direction);
  }, [direction, initialOrders, query, sortKey, status]);

  const visibleTotal = useMemo(
    () => visibleOrders.reduce((sum, order) => sum + totalFor(order), 0),
    [visibleOrders],
  );

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setQuery(new FormData(event.currentTarget).get("query")?.toString() ?? "");
  }

  function toggleDirection(): void {
    setDirection((current) => (current === "ascending" ? "descending" : "ascending"));
  }

  return (
    <section aria-labelledby="orders-heading" className="order-board">
      <header className="order-board-header">
        <div>
          <p className="eyebrow">Operations</p>
          <h1 id="orders-heading">Order activity</h1>
          <p>Search, sort, and review orders across every fulfillment state.</p>
        </div>
        <button className="primary-action" onClick={() => setQuery("")} type="button">
          Clear filters
        </button>
      </header>

      <form className="order-filters" onSubmit={submitSearch} role="search">
        <label htmlFor="order-query">Search orders</label>
        <input
          autoComplete="off"
          id="order-query"
          name="query"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Name, email, order ID, or SKU"
          type="search"
          value={query}
        />
        <label htmlFor="order-status">Status</label>
        <select
          id="order-status"
          onChange={(event) => setStatus(event.currentTarget.value as OrderStatus | "all")}
          value={status}
        >
          <option value="all">All statuses</option>
          {Object.keys(statusLabel).map((value) => (
            <option key={value} value={value}>
              {statusLabel[value as OrderStatus]}
            </option>
          ))}
        </select>
      </form>

      <div className="order-summary" aria-live="polite">
        <span>{visibleOrders.length} matching orders</span>
        <span>Total value {currency.format(visibleTotal)}</span>
      </div>

      <div className="order-table-scroll">
        <table className="order-table">
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Status</th>
              <th scope="col">Items</th>
              <th scope="col">
                <button onClick={() => setSortKey("total")} type="button">
                  Order total
                </button>
              </th>
              <th scope="col">
                <button onClick={toggleDirection} type="button">
                  Last updated ({direction})
                </button>
              </th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleOrders.length > 0 ? (
              visibleOrders.map((order) => (
                <OrderRow
                  key={order.id}
                  onArchive={onArchiveOrder}
                  onOpen={onOpenOrder}
                  order={order}
                />
              ))
            ) : (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">
                    <h2>No matching orders</h2>
                    <p>Try another customer name, status, or product code.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>
                Visible order value
              </th>
              <td>{currency.format(visibleTotal)}</td>
              <td colSpan={2}>{visibleOrders.length} rows</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
