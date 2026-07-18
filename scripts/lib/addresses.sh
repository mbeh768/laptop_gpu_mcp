#!/usr/bin/env bash
# Resolves host addresses from address_book.json. Source this file, then call:
#   addr=$(resolve_address maxbe)
set -euo pipefail

ADDRESS_BOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/address_book.json"

resolve_address() {
  local name="$1"
  if [ ! -f "$ADDRESS_BOOK" ]; then
    echo "address_book.json not found at $ADDRESS_BOOK" >&2
    return 1
  fi
  local ip
  ip=$(jq -r --arg name "$name" '.[$name] // empty' "$ADDRESS_BOOK")
  if [ -z "$ip" ]; then
    echo "No entry for '$name' in $ADDRESS_BOOK" >&2
    return 1
  fi
  echo "$ip"
}
