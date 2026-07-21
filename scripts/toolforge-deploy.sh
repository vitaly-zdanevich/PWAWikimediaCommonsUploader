#!/usr/bin/env bash
set -euo pipefail

# Builds the latest pushed revision with Toolforge Build Service and deploys it.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLFORGE_LOGIN="${TOOLFORGE_LOGIN:-vitaly-zdanevich}"
TOOLFORGE_HOST="${TOOLFORGE_HOST:-login.toolforge.org}"
TOOLFORGE_TOOL="${TOOLFORGE_TOOL:-pwa-commons-uploader-converter}"
TOOLFORGE_SSH="${TOOLFORGE_SSH:-${TOOLFORGE_LOGIN}@${TOOLFORGE_HOST}}"
TOOLFORGE_SSH_CONFIG="${TOOLFORGE_SSH_CONFIG:-}"
REPO="${REPO:-https://github.com/vitaly-zdanevich/PWAWikimediaCommonsUploader}"
HEALTH_URL="${HEALTH_URL:-https://${TOOLFORGE_TOOL}.toolforge.org/healthz}"
REMOTE_TEMPLATE="/tmp/${TOOLFORGE_TOOL}-service.template.$$"

if [[ ! "$TOOLFORGE_TOOL" =~ ^[a-z0-9-]+$ ]]; then
  echo "TOOLFORGE_TOOL may contain only lowercase letters, digits, and hyphens." >&2
  exit 2
fi
if [[ "$REPO" == *"'"* ]]; then
  echo "REPO must not contain a single quote." >&2
  exit 2
fi

ssh_args=()
if [[ -n "$TOOLFORGE_SSH_CONFIG" ]]; then
  ssh_args=(-F "$TOOLFORGE_SSH_CONFIG")
else
  for ssh_config_path in /etc/ssh/ssh_config /etc/ssh/ssh_config.d/*; do
    [[ -e "$ssh_config_path" ]] || continue
    if [[ "$(stat -c %u "$ssh_config_path" 2>/dev/null || printf 0)" != 0 ]]; then
      ssh_args=(-F /dev/null)
      break
    fi
  done
fi

echo "==> Installing service.template for $TOOLFORGE_TOOL"
scp "${ssh_args[@]}" "$ROOT_DIR/toolforge/service.template" "$TOOLFORGE_SSH:$REMOTE_TEMPLATE"
ssh "${ssh_args[@]}" "$TOOLFORGE_SSH" \
  "become '$TOOLFORGE_TOOL' install -m 600 '$REMOTE_TEMPLATE' '/data/project/$TOOLFORGE_TOOL/service.template'"
ssh "${ssh_args[@]}" "$TOOLFORGE_SSH" "rm -f '$REMOTE_TEMPLATE'"

echo "==> Building $REPO"
ssh "${ssh_args[@]}" "$TOOLFORGE_SSH" "become '$TOOLFORGE_TOOL' toolforge build start '$REPO'"

echo "==> Starting or restarting the buildservice webservice"
if ssh "${ssh_args[@]}" "$TOOLFORGE_SSH" "become '$TOOLFORGE_TOOL' toolforge webservice status" >/dev/null 2>&1; then
  if ! ssh "${ssh_args[@]}" "$TOOLFORGE_SSH" \
    "become '$TOOLFORGE_TOOL' toolforge webservice --template service.template restart"; then
    ssh "${ssh_args[@]}" "$TOOLFORGE_SSH" \
      "become '$TOOLFORGE_TOOL' toolforge webservice --template service.template start"
  fi
else
  ssh "${ssh_args[@]}" "$TOOLFORGE_SSH" \
    "become '$TOOLFORGE_TOOL' toolforge webservice --template service.template start"
fi

echo "==> Waiting for $HEALTH_URL"
for attempt in $(seq 1 60); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Deployment is healthy."
    echo "Logs: TOOLFORGE_TOOL=$TOOLFORGE_TOOL ./scripts/toolforge-logs.sh --follow"
    exit 0
  fi
  sleep 2
done

echo "Webservice did not become healthy after 120 seconds." >&2
exit 1
