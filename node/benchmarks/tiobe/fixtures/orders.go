package main

import (
    "fmt"
    "sort"
)

type Order struct {
    Customer string
    Cents int64
    Completed bool
}

// Summarize uses integer cents and returns deterministic customer ordering.
func Summarize(orders []Order) (map[string]int64, []string) {
    totals := make(map[string]int64)
    for _, order := range orders {
        if order.Completed && order.Cents >= 0 {
            totals[order.Customer] += order.Cents
        }
    }
    names := make([]string, 0, len(totals))
    for name := range totals { names = append(names, name) }
    sort.Strings(names)
    return totals, names
}

func main() {
    orders := []Order{{"Ada", 1995, true}, {"Zoë", 1250, true}, {"Ada", 500, false}}
    totals, names := Summarize(orders)
    const prefix = `<total currency="EUR">`
    for _, name := range names {
        fmt.Printf("%s%s: %d.%02d</total>\n", prefix, name, totals[name]/100, totals[name]%100)
    }
}
