#!/usr/bin/env bash
# Deploys laptop-gpu-mcp to a native-Linux host (not WSL — see deploy.sh for
# the maxbe/WSL variant) and stages a systemd unit for autostart.
#
# Does NOT touch anything requiring sudo (writing to /etc/systemd/system,
# systemctl enable/start) — those are printed at the end for you to run
# interactively, since sudo needs a real password prompt this script can't
# supply non-interactively.
#
# Usage: scripts/deploy-persistent-server.sh <host-name> [port]
#   <host-name> must be a key in address_book.json. SSH user is assumed to
#   match that name (e.g. "beantower" -> ssh beantower@<ip>).
#   [port] defaults to 8420.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/addresses.sh"

NAME="${1:?Usage: deploy-persistent-server.sh <host-name> [port]}"
PORT="${2:-8420}"
HOST_IP=$(resolve_address "$NAME")
TARGET="${NAME}@${HOST_IP}"
REMOTE_DIR="/home/${NAME}/laptop-gpu-mcp"

echo "==> Deploying to ${TARGET}:${REMOTE_DIR} (port ${PORT})"

tar czf - -C "$REPO_DIR" src package.json package-lock.json tsconfig.json |
  ssh "$TARGET" "mkdir -p ${REMOTE_DIR} && tar xzf - -C ${REMOTE_DIR}"

ssh "$TARGET" "export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; cd ${REMOTE_DIR} && npm install && npm run build"

NODE_BIN=$(ssh "$TARGET" "ls \$HOME/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1")
if [ -z "$NODE_BIN" ]; then
  echo "!! Could not find a node binary under ~/.nvm on ${TARGET}. Install node first (nvm install --lts)." >&2
  exit 1
fi

UNIT_FILE="$(mktemp)"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=laptop-gpu-mcp remote Python execution server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${NAME}
WorkingDirectory=${REMOTE_DIR}
ExecStart=${NODE_BIN} ${REMOTE_DIR}/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

scp "$UNIT_FILE" "${TARGET}:laptop-gpu-mcp.service"
rm -f "$UNIT_FILE"

echo ""
echo "==> Code deployed and built. Systemd unit staged at ~/laptop-gpu-mcp.service on ${NAME}."
echo "==> Run these on ${NAME} to finish (needs sudo):"
echo ""
echo "    sudo mv ~/laptop-gpu-mcp.service /etc/systemd/system/laptop-gpu-mcp.service"
echo "    sudo systemctl daemon-reload"
echo "    sudo systemctl enable --now laptop-gpu-mcp"
echo "    systemctl status laptop-gpu-mcp --no-pager"
echo ""
echo "==> If config.json needs (re)writing for this host, scp it to ${REMOTE_DIR}/config.json before starting the service."
