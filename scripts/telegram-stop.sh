#!/usr/bin/env zsh
# Stop the Unified Telegram Bot Server + Mission Dispatcher.
# Does NOT kill running Claude processes — those complete independently.
set -e

HUB_DIR="/srv/dev/agents/agent-generator"
SERVER_PID_FILE="$HUB_DIR/.unified-server.pid"
DISPATCHER_PID_FILE="$HUB_DIR/.mission-dispatcher.pid"

echo "Stopping Agent Generator services..."

# ── Stop dispatcher first ──────────────────────────────────────────────────
if [ -f "$DISPATCHER_PID_FILE" ]; then
  DPID=$(cat "$DISPATCHER_PID_FILE")
  if kill -0 "$DPID" 2>/dev/null; then
    echo "  Stopping dispatcher (PID: $DPID)..."
    kill "$DPID" 2>/dev/null || true

    for i in $(seq 1 5); do
      if ! kill -0 "$DPID" 2>/dev/null; then
        echo "  Dispatcher stopped"
        break
      fi
      sleep 0.5
    done

    if kill -0 "$DPID" 2>/dev/null; then
      echo "  Force-killing dispatcher..."
      kill -9 "$DPID" 2>/dev/null || true
    fi
  else
    echo "  Dispatcher not running (stale PID $DPID)"
  fi
  rm -f "$DISPATCHER_PID_FILE"
else
  echo "  No dispatcher PID file found"
fi

# ── Stop unified server ────────────────────────────────────────────────────
if [ ! -f "$SERVER_PID_FILE" ]; then
  echo "No unified server PID file found — checking for stray agent processes..."
  STRAY_PIDS=$(pgrep -f "telegram-server.js" 2>/dev/null || true)
  if [ -n "$STRAY_PIDS" ]; then
    echo "  Found stray process(es): $(echo "$STRAY_PIDS" | tr '\n' ' ')"
    kill $STRAY_PIDS 2>/dev/null || true
    echo "  Killed."
  else
    echo "  No stray processes found."
  fi

  # Also check for stray dispatchers
  STRAY_DISPATCH=$(pgrep -f "mission-dispatcher.sh" 2>/dev/null || true)
  if [ -n "$STRAY_DISPATCH" ]; then
    echo "  Found stray dispatcher: $(echo "$STRAY_DISPATCH" | tr '\n' ' ')"
    kill $STRAY_DISPATCH 2>/dev/null || true
    echo "  Killed."
  fi

  echo "Done."
  exit 0
fi

PID=$(cat "$SERVER_PID_FILE")

if ! kill -0 "$PID" 2>/dev/null; then
  echo "Server not running (PID $PID is gone), cleaning up PID file"
  rm -f "$SERVER_PID_FILE"
  echo "Done."
  exit 0
fi

echo "  Stopping unified server (PID: $PID)..."
kill "$PID" 2>/dev/null || true

for i in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "  Unified server stopped"
    rm -f "$SERVER_PID_FILE"
    echo "Done."
    exit 0
  fi
  sleep 0.5
done

echo "  Server didn't stop gracefully, force killing..."
kill -9 "$PID" 2>/dev/null || true
rm -f "$SERVER_PID_FILE"

# Aggressively clean up any stray Node agent processes
for agent_dir in /srv/dev/agents/*/; do
  server_js="${agent_dir}tools/telegram-server.js"
  pid_file="${agent_dir}.telegram-server.pid"
  if [ -f "$server_js" ]; then
    if [ -f "$pid_file" ]; then
      APID=$(cat "$pid_file" 2>/dev/null || true)
      if [ -n "$APID" ] && kill -0 "$APID" 2>/dev/null; then
        kill -9 "$APID" 2>/dev/null || true
      fi
      rm -f "$pid_file"
    fi
    PIDS=$(pgrep -f "node.*${agent_dir}tools/telegram-server" 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      kill -9 $PIDS 2>/dev/null || true
    fi
  fi
done

echo "Unified server force-stopped"
echo "Done."
