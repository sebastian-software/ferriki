# Aggregate completed orders and report exact integer cents.
orders <- data.frame(
  customer = c("Ada", "Zoë", "Ada", "Zoë"),
  cents = c(1995L, 1250L, 500L, 750L),
  completed = c(TRUE, TRUE, FALSE, TRUE),
  stringsAsFactors = FALSE
)

summarize_orders <- function(values, minimum = 0L) {
  required <- c("customer", "cents", "completed")
  if (!all(required %in% names(values))) {
    stop("Missing columns: ", paste(setdiff(required, names(values)), collapse = ", "))
  }
  valid <- subset(values, completed & cents >= minimum)
  totals <- aggregate(cents ~ customer, data = valid, FUN = sum)
  totals[order(-totals$cents, totals$customer), , drop = FALSE]
}

format_total <- function(customer, cents) {
  sprintf('<total customer="%s">€%.2f</total>', customer, cents / 100)
}

totals <- summarize_orders(orders)
labels <- mapply(format_total, totals$customer, totals$cents, USE.NAMES = FALSE)
cat(paste(labels, collapse = "\n"), "\n")
stopifnot(sum(totals$cents) == 3995L)
