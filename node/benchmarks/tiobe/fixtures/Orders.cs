using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Billing;

public sealed record Order(string Customer, decimal Amount, bool Completed = true);

public static partial class Orders
{
    [GeneratedRegex(@"^(?<name>[\w .'-]+):\s*(?<amount>\d+\.\d{2})$")]
    private static partial Regex OrderLine();

    public static IReadOnlyDictionary<string, decimal> Summarize(IEnumerable<Order> orders) =>
        orders.Where(o => o is { Completed: true, Amount: >= 0 })
            .GroupBy(o => o.Customer)
            .ToDictionary(group => group.Key, group => group.Sum(o => o.Amount));

    public static void Main()
    {
        Order[] orders = [new("Ada", 19.95m), new("Zoë", 12.50m), new("Ada", 5m, false)];
        foreach (var (customer, amount) in Summarize(orders))
        {
            var output = $"<total customer=\"{customer}\">€{amount:F2}</total>";
            Console.WriteLine(output);
        }
        Console.WriteLine(OrderLine().IsMatch("Zoë: 12.50"));
    }
}
