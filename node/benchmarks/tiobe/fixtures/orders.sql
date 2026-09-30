-- PostgreSQL: exact currency, constraints, joins, CTEs and window functions.
BEGIN;
CREATE TABLE customers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) > 0)
);
CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO customers (name) VALUES ('Ada'), ('Zoë');
INSERT INTO orders (customer_id, amount, completed)
VALUES (1, 19.95, TRUE), (2, 12.50, TRUE), (1, 5.00, FALSE);

WITH totals AS (
    SELECT c.id, c.name, SUM(o.amount) AS total
    FROM customers AS c
    JOIN orders AS o ON o.customer_id = c.id
    WHERE o.completed IS TRUE AND o.created_at >= DATE '2026-01-01'
    GROUP BY c.id, c.name
)
SELECT name, total, DENSE_RANK() OVER (ORDER BY total DESC) AS position,
       format('<total customer="%s">%s</total>', name, total) AS label
FROM totals
ORDER BY position, name;
COMMIT;
