#!/bin/bash
# Start the AI Agents web dashboard
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$AGENT_DIR/.web-dashboard.pid"
LOG_FILE="$AGENT_DIR/logs/web-dashboard.log"
PORT="${1:-3099}"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Dashboard already running (PID: $PID) at http://localhost:$PORT"
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

mkdir -p "$AGENT_DIR/logs"
node "$AGENT_DIR/tools/web-dashboard.js" "$PORT" >> "$LOG_FILE" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"
echo "Dashboard started (PID: $PID) at http://localhost:$PORT"
