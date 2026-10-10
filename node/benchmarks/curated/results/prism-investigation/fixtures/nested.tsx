type Row = { id: string; customer: string; total: number };
type Props = {
  rows: readonly Row[];
  onSelect: (id: string) => void;
};

export function Orders({ rows, onSelect }: Props) {
  return (
    <ul>
      {rows.map(({ id, customer, total }) => (
        <li key={id} onClick={() => onSelect(id)}>
          <strong>{customer}</strong>
          <span>{`€${total.toFixed(2)}`}</span>
        </li>
      ))}
    </ul>
  );
}
