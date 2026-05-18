#!/usr/bin/env zsh
# Start the Unified Telegram Bot Server + Mission Dispatcher.
set -e

HUB_DIR="/srv/dev/agents/agent-generator"
PID_FILE="$HUB_DIR/.unified-server.pid"
SERVER_SCRIPT="$HUB_DIR/tools/unified-server.js"
LOG_FILE="$HUB_DIR/logs/unified-server.log"
DISPATCHER_SCRIPT="$HUB_DIR/scripts/mission-dispatcher.sh"
DISPATCHER_PID_FILE="$HUB_DIR/.mission-dispatcher.pid"
DISPATCHER_LOG="$HUB_DIR/logs/dispatcher.log"

# ── Start Unified Server ───────────────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Unified server already running (PID: $PID)"
    echo "  Stop it first: $HUB_DIR/scripts/telegram-stop.sh"
    exit 0
  else
    echo "Stale PID file found (PID $PID is gone), cleaning up"
    rm -f "$PID_FILE"
  fi
fi

mkdir -p "$HUB_DIR/logs"

echo "Starting unified Telegram server (all agents)..."
nohup node "$SERVER_SCRIPT" >> "$LOG_FILE" 2>&1 &
PID=$!

sleep 2

if kill -0 "$PID" 2>/dev/null; then
  echo "  Unified server started (PID: $PID)"
  echo "  Log: $LOG_FILE"
else
  echo "Server failed to start. Check log:"
  tail -20 "$LOG_FILE"
  exit 1
fi

# ── Start Mission Dispatcher ────────────────────────────────────────────────
if [ -f "$DISPATCHER_PID_FILE" ]; then
  DPID=$(cat "$DISPATCHER_PID_FILE")
  if kill -0 "$DPID" 2>/dev/null; then
    echo "Dispatcher already running (PID: $DPID)"
  else
    echo "Stale dispatcher PID found, cleaning up"
    rm -f "$DISPATCHER_PID_FILE"
  fi
fi

if [ ! -f "$DISPATCHER_PID_FILE" ]; then
  echo "Starting mission dispatcher..."
  AGENT_DIR="$HUB_DIR" nohup bash "$DISPATCHER_SCRIPT" >> "$DISPATCHER_LOG" 2>&1 &
  DPID=$!

  sleep 1

  if kill -0 "$DPID" 2>/dev/null; then
    echo "  Dispatcher started (PID: $DPID)"
    echo "  Log: $DISPATCHER_LOG"
  else
    echo "  Dispatcher failed to start. Check log:"
    tail -10 "$DISPATCHER_LOG"
  fi
fi

echo ""
echo "Status: $HUB_DIR/scripts/telegram-status.sh"
echo ""
echo "Active agents:"
for agent_dir in /srv/dev/agents/*/; do
  name=$(basename "$agent_dir")
  [[ "$name" == "telegram-agent-kit" ]] && continue
  [[ "$name" == "agent-generator" ]] && continue
  env_file="$agent_dir/.env"
  if [ -f "$env_file" ] && grep -q "TELEGRAM_BOT_TOKEN" "$env_file" 2>/dev/null; then
    echo "  - $name"
  fi
done
