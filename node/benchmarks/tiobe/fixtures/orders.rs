use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
struct Order<'a> {
    customer: &'a str,
    cents: i64,
    completed: bool,
}

/// Aggregate exact integer amounts while borrowing customer names.
fn summarize<'a>(orders: &[Order<'a>]) -> BTreeMap<&'a str, i64> {
    let mut totals = BTreeMap::new();
    for order in orders.iter().filter(|o| o.completed && o.cents >= 0) {
        *totals.entry(order.customer).or_insert(0) += order.cents;
    }
    totals
}

fn main() {
    let orders = [
        Order { customer: "Ada", cents: 1995, completed: true },
        Order { customer: "Zoë", cents: 1250, completed: true },
        Order { customer: "Ada", cents: 500, completed: false },
    ];
    let prefix = r#"<total currency="EUR">"#;
    for (customer, cents) in summarize(&orders) {
        println!("{prefix}{customer}: {}.{:02}</total>", cents / 100, cents % 100);
    }
    assert_eq!(summarize(&orders).get("Ada"), Some(&1995));
}
