#include <algorithm>
#include <cstdint>
#include <iostream>
#include <map>
#include <ranges>
#include <string>
#include <vector>

namespace billing {
struct Order {
    std::string customer;
    std::int64_t cents;
    bool completed = true;
};

template <std::ranges::input_range Range>
auto summarize(const Range& orders) {
    std::map<std::string, std::int64_t> totals;
    for (const auto& order : orders | std::views::filter([](const auto& o) {
        return o.completed && o.cents >= 0;
    })) {
        totals[order.customer] += order.cents;
    }
    return totals;
}
} // namespace billing

int main() {
    using billing::Order;
    const std::vector<Order> orders{{"Ada", 1995}, {"Zoë", 1250}, {"Ada", 500, false}};
    constexpr auto label = R"xml(<total currency="EUR">)xml";
    for (const auto& [name, cents] : billing::summarize(orders)) {
        std::cout << label << name << ": " << cents << "</total>\n";
    }
}
