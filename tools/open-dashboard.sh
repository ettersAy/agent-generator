#!/usr/bin/env bash
# open-dashboard.sh — Start (if needed) and open the Agent Dashboard in a browser.
# Single command replaces: find port, check process, start, curl test, print link.
#
# Usage:
#   open-dashboard.sh              Open main dashboard
#   open-dashboard.sh --wiki       Open wiki
#   open-dashboard.sh --logs       Open logs page

set -euo pipefail

PORT=3099
DASHBOARD_SCRIPT="/srv/dev/agents/agent-generator/tools/web-dashboard.js"
LOG_FILE="/srv/dev/agents/agent-generator/logs/web-dashboard.log"
BASE_URL="http://localhost:${PORT}"

case "${1:-}" in
  --wiki)  URL="${BASE_URL}/wiki" ;;
  --logs)  URL="${BASE_URL}/logs" ;;
  *)       URL="${BASE_URL}" ;;
esac

# ── Start dashboard if not running ───────────────────────────────────────────
if ! curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/status" 2>/dev/null | grep -q 200; then
  echo "Dashboard not running. Starting..."
  nohup node "$DASHBOARD_SCRIPT" "$PORT" >> "$LOG_FILE" 2>&1 &
  sleep 1

  # Wait up to 5s for it to be ready
  for i in $(seq 1 10); do
    if curl -s -o /dev/null "$BASE_URL/api/status" 2>/dev/null; then
      echo "Dashboard ready."
      break
    fi
    sleep 0.5
  done
else
  echo "Dashboard already running on port $PORT."
fi

# ── Open browser ─────────────────────────────────────────────────────────────
echo "Opening $URL ..."
if command -v xdg-open &>/dev/null; then
  xdg-open "$URL" 2>/dev/null &
elif command -v open &>/dev/null; then
  open "$URL" 2>/dev/null &
elif command -v sensible-browser &>/dev/null; then
  sensible-browser "$URL" 2>/dev/null &
else
  echo "No browser command found. URL: $URL"
fi

echo "Dashboard: $URL"
