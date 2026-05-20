#!/usr/bin/env bash
# Inter-Agent Respond — Send a response back to another agent via the shared mailbox.
#
# Usage: agent-respond.sh <target-agent> <request-id> "<response message>"
#        echo "response" | agent-respond.sh <target-agent> <request-id>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source /srv/dev/agents/_shared/tools/lib/agent-common.sh

# ── Identity ─────────────────────────────────────────────────────────────
detect_agent_identity || { echo "ERROR: Could not determine agent identity" >&2; exit 1; }

# ── Parse args ───────────────────────────────────────────────────────────
TARGET=""
REQUEST_ID=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *)
      [ -z "$TARGET" ] && { TARGET="$1"; shift; continue; }
      [ -z "$REQUEST_ID" ] && { REQUEST_ID="$1"; shift; continue; }
      [ -z "$MESSAGE" ] && { MESSAGE="$1"; shift; continue; }
      shift ;;
  esac
done

if [ -z "$MESSAGE" ] && [ ! -t 0 ]; then
  MESSAGE=$(cat)
fi

if [ -z "$TARGET" ] || [ -z "$REQUEST_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: agent-respond.sh <target-agent> <request-id> \"<response>\"" >&2
  list_agents_registry
  exit 1
fi

# ── Resolve target ───────────────────────────────────────────────────────
lookup_agent "$TARGET" || { echo "ERROR: Agent '$TARGET' not in registry." >&2; list_agents_registry; exit 1; }
TARGET_USERNAME="$_agent_username"

# ── Create response ──────────────────────────────────────────────────────
FILE=$(create_message_file "$TARGET" "response" "Re: ${REQUEST_ID:0:40}" "$MESSAGE" "$REQUEST_ID")

echo "Response → $TARGET (reply to ${REQUEST_ID:0:30}...)"

# ── Telegram notification ────────────────────────────────────────────────
load_agent_env
send_telegram_notify "${_agent_username} responded to ${TARGET_USERNAME}: ${MESSAGE:0:300}" && echo "Notification sent" || true
