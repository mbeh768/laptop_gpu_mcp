#!/usr/bin/env bash
# Restarts the MCP server on maxbe over SSH (kills any existing dist/index.js,
# then relaunches with the env vars documented in NOTES.md).
# Usage: scripts/restart-remote.sh [port]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/addresses.sh"

PORT="${1:-8421}"
HOST_IP=$(resolve_address maxbe)

ssh "maxBe@${HOST_IP}" "wsl.exe -- bash -ic \"pkill -f dist/index.js; sleep 1; cd /home/maxbe/laptop-gpu-mcp && SCRIPTS_BASE_DIR=/home/maxbe/scripts CONDA_BASE_DIR=/home/maxbe/miniconda3 ALLOWED_CONDA_ENVS=mayo_pytorch MCP_HOST=0.0.0.0 MCP_PORT=${PORT} node dist/index.js > server.log 2>&1 &\""
