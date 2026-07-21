#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [--tail 200] [--since 1h] [--follow] [--errors] [--local]

Options:
  --tail N              read the last N lines (default: 200)
  --all                 do not limit the number of lines
  --since 30s|5m|2h     read logs newer than this kubectl duration
  --follow, -f          stream new lines
  --errors, -e          show only error, panic, failed, warning, or exception lines
  --local               run after 'become TOOL' on a Toolforge bastion

Environment:
  TOOLFORGE_LOGIN       SSH login (default: vitaly-zdanevich)
  TOOLFORGE_HOST        SSH host (default: login.toolforge.org)
  TOOLFORGE_TOOL        tool account (default: pwa-commons-uploader-converter)
  TOOLFORGE_DEPLOYMENT  Kubernetes deployment (default: TOOLFORGE_TOOL)
  TOOLFORGE_SSH         full SSH target override
  ERROR_PATTERN         extended regular expression used by --errors
EOF
}

TOOLFORGE_LOGIN="${TOOLFORGE_LOGIN:-vitaly-zdanevich}"
TOOLFORGE_HOST="${TOOLFORGE_HOST:-login.toolforge.org}"
TOOLFORGE_TOOL="${TOOLFORGE_TOOL:-pwa-commons-uploader-converter}"
TOOLFORGE_DEPLOYMENT="${TOOLFORGE_DEPLOYMENT:-$TOOLFORGE_TOOL}"
TOOLFORGE_SSH="${TOOLFORGE_SSH:-${TOOLFORGE_LOGIN}@${TOOLFORGE_HOST}}"
KUBECTL_GOMAXPROCS="${KUBECTL_GOMAXPROCS:-2}"
ERROR_PATTERN="${ERROR_PATTERN:-error|panic|failed|warn|exception}"
TAIL="${TAIL:-200}"
SINCE="${SINCE:-}"
FOLLOW=0
ERRORS_ONLY=0
LOCAL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tail) TAIL="${2:?--tail requires a number}"; shift 2 ;;
    --all) TAIL=""; shift ;;
    --since) SINCE="${2:?--since requires a duration}"; shift 2 ;;
    --follow|-f) FOLLOW=1; shift ;;
    --errors|-e) ERRORS_ONLY=1; shift ;;
    --local) LOCAL=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -n "$TAIL" && ! "$TAIL" =~ ^[0-9]+$ ]]; then
  echo "--tail must be a non-negative integer." >&2
  exit 2
fi
if [[ ! "$TOOLFORGE_TOOL" =~ ^[a-z0-9-]+$ ]]; then
  echo "TOOLFORGE_TOOL contains invalid characters." >&2
  exit 2
fi

log_args=(logs "deploy/$TOOLFORGE_DEPLOYMENT")
if [[ -n "$TAIL" ]]; then
  log_args+=("--tail=$TAIL")
fi
if [[ -n "$SINCE" ]]; then
  log_args+=("--since=$SINCE")
fi
if [[ "$FOLLOW" == 1 ]]; then
  log_args+=(--follow)
fi

if [[ "$LOCAL" == 1 ]]; then
  command=(env "GOMAXPROCS=$KUBECTL_GOMAXPROCS" kubectl "${log_args[@]}")
else
  command=(ssh "$TOOLFORGE_SSH" become "$TOOLFORGE_TOOL" env \
    "GOMAXPROCS=$KUBECTL_GOMAXPROCS" kubectl "${log_args[@]}")
fi

if [[ "$ERRORS_ONLY" == 1 ]]; then
  "${command[@]}" | grep --line-buffered -iE "$ERROR_PATTERN" || true
else
  "${command[@]}"
fi
