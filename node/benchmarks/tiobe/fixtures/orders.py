"""Aggregate completed orders without floating-point currency errors."""
from dataclasses import dataclass
from decimal import Decimal
from collections import defaultdict
import re

@dataclass(frozen=True)
class Order:
    customer: str
    amount: Decimal
    status: str = "completed"

ORDER_LINE = re.compile(r"^(?P<name>[\w .'-]+):\s*(?P<amount>\d+\.\d{2})$")

def parse_orders(text: str) -> list[Order]:
    orders = []
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip() or line.startswith("#"):
            continue
        match = ORDER_LINE.fullmatch(line)
        if match is None:
            raise ValueError(f"Invalid order on line {number}: {line!r}")
        orders.append(Order(match["name"], Decimal(match["amount"])))
    return orders

def summarize(orders: list[Order]) -> dict[str, Decimal]:
    totals = defaultdict(Decimal)
    for order in orders:
        if order.status == "completed":
            totals[order.customer] += order.amount
    return dict(sorted(totals.items(), key=lambda pair: pair[1], reverse=True))

if __name__ == "__main__":
    # Unicode, delimiters and interpolation exercise string rules.
    source = """Zoë: 12.50
Ada: 19.95
Zoë: 7.50"""
    for customer, total in summarize(parse_orders(source)).items():
        print(f"<customer>{customer}</customer>: €{total:.2f}")
