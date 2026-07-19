#!/usr/bin/env bash
# Sends the current code to a host via a throwaway GitHub branch instead of
# tar/scp — useful for hosts where the shell-quoting chain is unreliable
# (see NOTES.md item 3), or just to avoid re-uploading unchanged bytes.
#
# Commits src/package*.json/tsconfig.json onto a new branch named
# mcp-deploy-<timestamp>, pushes it to origin, then clones/pulls that branch
# on the target host. Only those specific deploy-relevant paths are staged —
# never `git add -A` — so unrelated working-tree state (e.g. other
# in-progress files) is never swept in.
#
# NOTE: if origin/<repo> is private, the remote host needs its own git
# credentials (SSH key or PAT) already configured — a first-time clone will
# hang waiting for an interactive credential prompt over this non-interactive
# SSH pipe. If that happens, run the git clone step manually on the host
# once (enter credentials interactively there), then re-run this script.
#
# Usage: scripts/deploy-via-github.sh <host-name> [port]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/addresses.sh"

NAME="${1:?Usage: deploy-via-github.sh <host-name> [port]}"
PORT="${2:-8420}"
HOST_IP=$(resolve_address "$NAME")
TARGET="${NAME}@${HOST_IP}"
REMOTE_DIR="/home/${NAME}/laptop-gpu-mcp"

cd "$REPO_DIR"

ORIGINAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
DEPLOY_BRANCH="mcp-deploy-$(date +%Y%m%d-%H%M%S)"
REMOTE_URL=$(git remote get-url origin)

echo "==> Creating branch ${DEPLOY_BRANCH} from ${ORIGINAL_BRANCH}"
git checkout -b "$DEPLOY_BRANCH"

DEPLOY_PATHS=(src package.json package-lock.json tsconfig.json config.example.json)

git add -- "${DEPLOY_PATHS[@]}"
if git diff --cached --quiet -- "${DEPLOY_PATHS[@]}"; then
  echo "==> No changes to deploy-relevant files vs ${ORIGINAL_BRANCH}; branch will just point at the same code."
else
  # Commit only these paths, even if unrelated files happen to be staged in
  # the index from other in-progress work — never sweep in unrelated state.
  git commit -m "Deploy snapshot for ${NAME} ($(date -u +%Y-%m-%dT%H:%M:%SZ))" -- "${DEPLOY_PATHS[@]}"
fi

git push -u origin "$DEPLOY_BRANCH"

echo "==> Switching back to ${ORIGINAL_BRANCH} locally"
git checkout "$ORIGINAL_BRANCH"

echo "==> Fetching ${DEPLOY_BRANCH} on ${TARGET}"
ssh "$TARGET" "
  set -e
  if [ -d ${REMOTE_DIR}/.git ]; then
    cd ${REMOTE_DIR} && git fetch origin ${DEPLOY_BRANCH} && git checkout ${DEPLOY_BRANCH} && git reset --hard origin/${DEPLOY_BRANCH}
  elif [ -d ${REMOTE_DIR} ]; then
    # Directory exists from a prior non-git deploy (e.g. tar/scp) — turn it
    # into a git checkout in place rather than failing or wiping it.
    cd ${REMOTE_DIR} && git init -q && git remote add origin ${REMOTE_URL} && git fetch origin ${DEPLOY_BRANCH} && git checkout -f ${DEPLOY_BRANCH}
  else
    git clone -b ${DEPLOY_BRANCH} --single-branch ${REMOTE_URL} ${REMOTE_DIR}
  fi
"

ssh "$TARGET" "export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; cd ${REMOTE_DIR} && npm install && npm run build"

echo ""
echo "==> Done. ${NAME} is now on branch ${DEPLOY_BRANCH}, built."
echo "==> config.json is gitignored and was NOT touched — copy/write it separately if needed."
echo "==> To (re)start the service: sudo systemctl restart laptop-gpu-mcp  (or see deploy-persistent-server.sh to set autostart up for the first time)."
