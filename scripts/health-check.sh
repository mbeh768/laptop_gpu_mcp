#!/usr/bin/env bash
# Checks whether the MCP server on maxbe is up.
# Usage: scripts/health-check.sh [port]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/addresses.sh"

PORT="${1:-8421}"
HOST_IP=$(resolve_address maxbe)

curl -s -f "http://${HOST_IP}:${PORT}/health"
