#!/usr/bin/env bash
# Inter-Agent Ask — Send a question/message to another AI agent via the shared mailbox.
#
# Usage: agent-ask.sh [--type question|config-request] <target-agent> "<message>"
#        echo "message" | agent-ask.sh <target-agent>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source /srv/dev/agents/_shared/tools/lib/agent-common.sh

# ── Identity ─────────────────────────────────────────────────────────────
detect_agent_identity || { echo "ERROR: Could not determine agent identity" >&2; exit 1; }

# ── Parse args ───────────────────────────────────────────────────────────
MSG_TYPE="question"
TARGET=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)       MSG_TYPE="$2"; shift 2 ;;
    --type=*)     MSG_TYPE="${1#*=}"; shift ;;
    --config)     MSG_TYPE="config-request"; shift ;;
    -*)           echo "Unknown flag: $1" >&2; exit 1 ;;
    *)
      [ -z "$TARGET" ] && { TARGET="$1"; shift; continue; }
      [ -z "$MESSAGE" ] && { MESSAGE="$1"; shift; continue; }
      shift ;;
  esac
done

# Read message from stdin if not in args
if [ -z "$MESSAGE" ] && [ ! -t 0 ]; then
  MESSAGE=$(cat)
fi

if [ -z "$TARGET" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: agent-ask.sh [--type question|config-request] <target-agent> \"<message>\"" >&2
  list_agents_registry
  exit 1
fi

validate_message_type "$MSG_TYPE" || exit 1

# ── Resolve target ───────────────────────────────────────────────────────
lookup_agent "$TARGET" || { echo "ERROR: Agent '$TARGET' not in registry." >&2; list_agents_registry; exit 1; }
TARGET_USERNAME="$_agent_username"

# ── Create message ───────────────────────────────────────────────────────
FILE=$(create_message_file "$TARGET" "$MSG_TYPE" "${MESSAGE:0:120}" "$MESSAGE")

UUID=$(basename "$FILE" .json | sed 's/.*-\([^-]*\)$/\1/')
echo "Message $UUID → $TARGET"

# ── Telegram notification ────────────────────────────────────────────────
load_agent_env
TYPE_LABEL=""
case "$MSG_TYPE" in
  config-request) TYPE_LABEL="[CONFIG REQUEST] " ;;
  response)       TYPE_LABEL="[RESPONSE] " ;;
esac

send_telegram_notify "${_agent_username} asked ${TARGET_USERNAME}: ${TYPE_LABEL}${MESSAGE:0:300}" && echo "Notification sent" || true
echo "$UUID"
