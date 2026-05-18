#!/bin/bash
# Stop the AI Agents web dashboard
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$AGENT_DIR/.web-dashboard.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill "$PID" 2>/dev/null; then
    echo "Dashboard stopped (PID: $PID)"
    rm -f "$PID_FILE"
  else
    echo "Dashboard not running (stale PID)"
    rm -f "$PID_FILE"
  fi
else
  echo "No dashboard PID file found"
fi
