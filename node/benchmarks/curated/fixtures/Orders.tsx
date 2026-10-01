import type { ReactElement } from "react";
import { useMemo, useState } from "react";

interface Order {
  id: string;
  customer: string;
  total: number;
  paid: boolean;
}
interface Props {
  orders: readonly Order[];
  onSelect: (id: string) => void;
}

// Searchable, typed JSX with expressions and event handlers.
export function OrderTable({ orders, onSelect }: Props): ReactElement {
  const [query, setQuery] = useState("");
  const visible = useMemo(
    () => orders.filter((order) => order.customer.toLowerCase().includes(query.toLowerCase())),
    [orders, query],
  );
  const total = visible.reduce((sum, order) => sum + order.total, 0);
  return (
    <section aria-label="Orders & customers" className="orders">
      <label htmlFor="search">Search München & café</label>
      <input id="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {visible.map(({ id, customer, total, paid }) => (
            <tr key={id} data-paid={paid} onClick={() => onSelect(id)}>
              <td>{customer}</td>
              <td>
                {total.toFixed(2)} {paid ? <strong>Paid</strong> : <em>Pending</em>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* A literal and a JSX interpolation share the same line. */}
      <footer>
        {visible.length} orders · €{total.toFixed(2)}
      </footer>
    </section>
  );
}
