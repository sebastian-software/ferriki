# Frozen values, keyword arguments, blocks, regexes and interpolation.
require "json"
Order = Data.define(:id, :customer, :total, :paid)

class OrderSummary
  def initialize(orders, currency: "EUR")
    @orders = orders
    @currency = currency
  end

  def paid
    @orders.select(&:paid).sort_by { |order| -order.total }
  end

  def render
    lines = paid.map do |order|
      name = order.customer.gsub(/[<>&]/, "_")
      "#{order.id}: #{name} — #{format('%.2f', order.total)} #{@currency}"
    end
    <<~REPORT
      Paid orders: #{paid.length}
      #{lines.join("\n")}
    REPORT
  end
end

orders = [
  Order.new(id: "ORD-42", customer: "München <team> & café", total: 39.90, paid: true),
  Order.new(id: "ORD-43", customer: "Pending", total: 12.50, paid: false)
]
puts OrderSummary.new(orders).render
puts JSON.generate(orders.map(&:to_h))
