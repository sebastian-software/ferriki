# Order dashboard

A dashboard for **München**, _café_ and customers containing `<`, `>` or `&`.
See [the API](https://example.test/orders?status=paid&limit=20).

> Paid orders are included in the total. Pending orders remain visible.

| Status  | Count |  Total |
| :------ | ----: | -----: |
| Paid    |     2 | €79.80 |
| Pending |     1 | €12.50 |

## Typed client

```typescript
interface Order {
  id: string;
  total: number;
}
const sum = (orders: Order[]) => orders.reduce((n, order) => n + order.total, 0);
console.log(sum([{ id: "ORD-42", total: 39.9 }]));
```

```tsx
export const Total = ({ value }: { value: number }) => <strong>€{value.toFixed(2)}</strong>;
```

```json
{ "customer": "München <team> & café", "paid": true, "total": 39.9 }
```

- [x] Validate the response
- [ ] Ship the dashboard

Run `curl --fail` to inspect the response:

```bash
curl --fail 'https://example.test/orders?status=paid' | jq '.[].total'
```

<div class="note">Use &amp; for a literal ampersand in HTML.</div>
