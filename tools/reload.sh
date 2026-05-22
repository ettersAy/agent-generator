#!/usr/bin/env bash
# reload.sh — Restart the entire agent ecosystem with one command.
# Kills old processes, cleans stale PIDs, starts fresh, verifies health.
#
# Usage:
#   reload.sh              Full restart + health check
#   reload.sh --quick       Restart without health check (faster)
#   reload.sh --dashboard   Restart only the web dashboard

set -euo pipefail

HUB_DIR="/srv/dev/agents/agent-generator"
START_SCRIPT="$HUB_DIR/scripts/telegram-start.sh"
STOP_SCRIPT="$HUB_DIR/scripts/telegram-stop.sh"

MODE="${1:---full}"

case "$MODE" in
  --dashboard)
    echo "Restarting web dashboard..."
    pkill -f "web-dashboard.js" 2>/dev/null || true
    sleep 1
    nohup node "$HUB_DIR/tools/web-dashboard.js" 3099 >> "$HUB_DIR/logs/web-dashboard.log" 2>&1 &
    sleep 1
    echo "Dashboard restarted (PID: $(pgrep -f web-dashboard.js))"
    bash "$HUB_DIR/tools/open-dashboard.sh"
    ;;
  --quick)
    echo "Quick restart..."
    bash "$STOP_SCRIPT" 2>/dev/null || true
    sleep 2
    bash "$START_SCRIPT"
    echo "Done."
    ;;
  *)
    echo "Full restart with health check..."
    bash "$STOP_SCRIPT" 2>/dev/null || true
    sleep 2
    bash "$START_SCRIPT"
    sleep 3
    echo ""
    bash "$HUB_DIR/tools/health-check.sh" --compact
    ;;
esac
