#!/usr/bin/env bash
# Quoting, arrays, expansion, regexes, command substitution and here-documents.
set -euo pipefail
readonly API_URL="${API_URL:-https://example.test/orders}"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
statuses=(paid shipped)

fetch_orders() {
  local status="$1"
  curl --fail --silent --show-error \
    --get --data-urlencode "status=$status" \
    "$API_URL" > "$work_dir/$status.json"
}

for status in "${statuses[@]}"; do
  [[ "$status" =~ ^[a-z]+$ ]] || exit 2
  fetch_orders "$status"
  count="$(jq 'length' "$work_dir/$status.json")"
  printf '%s: %s orders\n' "$status" "$count"
done

customer='München <team> & café'
cat <<REPORT
Customer: $customer
Report directory: ${work_dir}
REPORT
cat <<'JSON' > "$work_dir/request.json"
{"customer": "München <team> & café", "paid": true}
JSON

case "${1:-summary}" in
  summary) jq -s 'add | map(.total) | add' "$work_dir/paid.json" "$work_dir/shipped.json" ;;
  *) printf 'Unknown command: %s\n' "$1" >&2; exit 1 ;;
esac
