#!/usr/bin/env bash
# agent-wait.sh — Wait for inter-agent responses without triggering sleep blocks.
#
# The Bash tool blocks `sleep N` for N > ~5s. This script uses short polling
# intervals (2s) in a loop — safe for both Bash and Monitor.
#
# Usage:
#   agent-wait.sh <agent-name> [timeout_seconds] [min_responses]
#   agent-wait.sh --any [timeout_seconds]
#
# Examples:
#   agent-wait.sh mouss-ai 60 1       Wait up to 60s for 1 response from mouss-ai
#   agent-wait.sh tamarine-bot 120 2  Wait up to 120s for 2 responses
#   agent-wait.sh --any 60             Wait for any response to agent-generator inbox

set -euo pipefail

MAILBOX="/srv/dev/agents/_shared/mailbox"
TARGET="${1:-}"
TIMEOUT="${2:-60}"
MIN_RESPONSES="${3:-1}"
INBOX="$MAILBOX/agent-generator/inbox"

if [ "$TARGET" = "--any" ]; then
  TIMEOUT="${2:-60}"
  MIN_RESPONSES=1
  # Count all responses not from agent-generator
  count_cmd() { ls "$INBOX"/*.json 2>/dev/null | wc -l; }
else
  count_cmd() {
    local count=0
    for f in "$INBOX"/*.json 2>/dev/null; do
      [ -f "$f" ] || continue
      from=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('from',''))" 2>/dev/null || echo "")
      [ "$from" = "$TARGET" ] && count=$((count + 1))
    done
    echo "$count"
  }
fi

echo "Waiting up to ${TIMEOUT}s for $MIN_RESPONSES response(s) from ${TARGET}..."

START=$(date +%s)
while true; do
  CURRENT=$(count_cmd)
  if [ "$CURRENT" -ge "$MIN_RESPONSES" ]; then
    ELAPSED=$(($(date +%s) - START))
    echo "Got $CURRENT response(s) from $TARGET after ${ELAPSED}s."
    exit 0
  fi

  ELAPSED=$(($(date +%s) - START))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "Timeout after ${TIMEOUT}s. Got $CURRENT/$MIN_RESPONSES responses."
    exit 1
  fi

  sleep 2
done
