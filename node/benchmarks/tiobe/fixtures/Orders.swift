import Foundation

struct Order: Equatable {
    let customer: String
    let cents: Int64
    var completed = true
}

/// Sum exact integer currency and retain deterministic customer ordering.
func summarize(_ orders: [Order]) -> [(String, Int64)] {
    let totals = orders.lazy.filter { $0.completed && $0.cents >= 0 }
        .reduce(into: [String: Int64]()) { totals, order in
            totals[order.customer, default: 0] += order.cents
        }
    return totals.sorted { lhs, rhs in
        lhs.value == rhs.value ? lhs.key < rhs.key : lhs.value > rhs.value
    }.map { ($0.key, $0.value) }
}

let orders = [
    Order(customer: "Ada", cents: 1995),
    Order(customer: "Zoë", cents: 1250),
    Order(customer: "Ada", cents: 500, completed: false),
]
for (name, cents) in summarize(orders) {
    let output = """
        <total customer="\(name)">
          \(cents) cents
        </total>
        """
    print(output)
}
assert(summarize(orders).count == 2)
