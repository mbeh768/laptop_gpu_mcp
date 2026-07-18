#!/usr/bin/env bash
# Copies src/package*.json/tsconfig.json to maxbe over SSH and builds it in WSL.
# scp lands in the Windows shell and can't see WSL paths, so this tars over ssh instead.
# Usage: scripts/deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/addresses.sh"

HOST_IP=$(resolve_address maxbe)

tar czf - -C "$REPO_DIR" src package.json package-lock.json tsconfig.json |
  ssh "maxBe@${HOST_IP}" 'wsl.exe -- bash -ic "mkdir -p /home/maxbe/laptop-gpu-mcp && cd /home/maxbe/laptop-gpu-mcp && tar xzf -"'

ssh "maxBe@${HOST_IP}" 'wsl.exe -- bash -ic "cd /home/maxbe/laptop-gpu-mcp && npm install && npm run build"'
