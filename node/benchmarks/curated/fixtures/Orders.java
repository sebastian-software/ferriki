package example.billing;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Aggregate completed orders using exact decimal amounts. */
public final class Orders {
    record Order(String customer, BigDecimal amount, boolean completed) {}

    public static Map<String, BigDecimal> summarize(List<Order> orders) {
        var totals = new TreeMap<String, BigDecimal>();
        orders.stream()
            .filter(Order::completed)
            .forEach(order -> totals.merge(order.customer(), order.amount(), BigDecimal::add));
        return Map.copyOf(totals);
    }

    public static void main(String[] args) {
        var orders = List.of(
            new Order("Ada", new BigDecimal("19.95"), true),
            new Order("Zoë", new BigDecimal("12.50"), true),
            new Order("Ada", new BigDecimal("5.00"), false)
        );
        String template = """
            <total customer="%s">%s</total>
            """;
        summarize(orders).forEach((name, amount) ->
            System.out.printf(template, name, amount.toPlainString()));
    }
}
