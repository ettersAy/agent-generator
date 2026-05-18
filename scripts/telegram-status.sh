#!/usr/bin/env zsh
# Check the health/status of the Unified Telegram Bot Server + Mission Dispatcher.
# Shows all agents, their bot connectivity, and mission queue state.

HUB_DIR="/srv/dev/agents/agent-generator"
SERVER_PID_FILE="$HUB_DIR/.unified-server.pid"
DISPATCHER_PID_FILE="$HUB_DIR/.mission-dispatcher.pid"
SERVER_LOG="$HUB_DIR/logs/unified-server.log"
DISPATCHER_LOG="$HUB_DIR/logs/dispatcher.log"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Agent Generator — Status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Unified Server ───────────────────────────────────────────────────────
echo ""
echo "Telegram Server:"
if [ -f "$SERVER_PID_FILE" ]; then
  PID=$(cat "$SERVER_PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "  Status: Running (PID: $PID)"
    ELAPSED=$(ps -o etime= -p "$PID" 2>/dev/null | xargs)
    echo "  Uptime: $ELAPSED"
    CHILDREN=$(pgrep -P "$PID" 2>/dev/null | wc -l)
    echo "  Children: $CHILDREN agent process(es)"
  else
    echo "  Status: Dead (stale PID $PID)"
  fi
else
  echo "  Status: Not running"
fi

# ── Mission Dispatcher ────────────────────────────────────────────────────
echo ""
echo "Mission Dispatcher:"
if [ -f "$DISPATCHER_PID_FILE" ]; then
  DPID=$(cat "$DISPATCHER_PID_FILE")
  if kill -0 "$DPID" 2>/dev/null; then
    echo "  Status: Running (PID: $DPID)"
    DELAPSED=$(ps -o etime= -p "$DPID" 2>/dev/null | xargs)
    echo "  Uptime: $DELAPSED"

    # Count running Claude processes
    RUNNING_MISSIONS=$(ls "$HUB_DIR/missions/in-progress/"*.pid 2>/dev/null | wc -l)
    echo "  Active missions: $RUNNING_MISSIONS"

    # Show running mission details
    for pidfile in "$HUB_DIR/missions/in-progress/"*.pid; do
      [ -f "$pidfile" ] || continue
      mbasename=$(basename "$pidfile" .pid)
      mpid=$(cat "$pidfile" 2>/dev/null || echo "?")
      melapsed="?"
      if [ -n "$mpid" ] && [ "$mpid" != "?" ]; then
        melapsed=$(ps -o etime= -p "$mpid" 2>/dev/null | xargs || echo "?")
      fi
      echo "    • ${mbasename: -40} — runner PID $mpid, elapsed $melapsed"
    done
  else
    echo "  Status: Dead (stale PID $DPID)"
  fi
else
  echo "  Status: Not running"
fi

# ── Mission Queue ─────────────────────────────────────────────────────────
echo ""
echo "Mission Queue:"
for dir in todo in-progress done failed; do
  dirpath="$HUB_DIR/missions/$dir"
  count=$(ls "$dirpath"/*.md 2>/dev/null | wc -l)
  case "$dir" in
    todo)        icon="⏳" ;;
    in-progress) icon="🔄" ;;
    done)        icon="✅" ;;
    failed)      icon="❌" ;;
  esac
  echo "  $icon $dir: $count"
done

# ── Agents ────────────────────────────────────────────────────────────────
echo ""
echo "Agents:"
for agent_dir in /srv/dev/agents/*/; do
  name=$(basename "$agent_dir")
  [[ "$name" == "telegram-agent-kit" ]] && continue
  env_file="$agent_dir/.env"
  server_file="$agent_dir/tools/telegram-server.js"

  if [ ! -f "$env_file" ] || ! grep -q "TELEGRAM_BOT_TOKEN" "$env_file" 2>/dev/null; then
    continue
  fi

  token=$(grep "^TELEGRAM_BOT_TOKEN=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)
  chat_id=$(grep "^TELEGRAM_CHAT_ID=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)
  token_suffix="...${token: -8}"

  agent_pid_file="$agent_dir/.telegram-server.pid"
  agent_running=false
  if [ -f "$agent_pid_file" ]; then
    agent_pid=$(cat "$agent_pid_file")
    if kill -0 "$agent_pid" 2>/dev/null; then
      agent_running=true
    fi
  fi

  printf "  %-18s" "[$name]"
  if [ -f "$server_file" ]; then
    echo -n " token=$token_suffix chat=$chat_id"
    if $agent_running; then
      echo "  running"
    else
      echo "  configured"
    fi
  else
    echo "  no telegram-server.js"
  fi
done

# ── Recent Logs ───────────────────────────────────────────────────────────
echo ""
echo "Recent server logs:"
if [ -f "$SERVER_LOG" ]; then
  tail -5 "$SERVER_LOG"
else
  echo "  (no server log yet)"
fi

echo ""
echo "Recent dispatcher logs:"
if [ -f "$DISPATCHER_LOG" ]; then
  tail -5 "$DISPATCHER_LOG"
else
  echo "  (no dispatcher log yet)"
fi

# ── API Connectivity ──────────────────────────────────────────────────────
echo ""
echo "API connectivity:"
for agent_dir in /srv/dev/agents/*/; do
  name=$(basename "$agent_dir")
  [[ "$name" == "telegram-agent-kit" ]] && continue
  env_file="$agent_dir/.env"
  [ ! -f "$env_file" ] && continue

  token=$(grep "^TELEGRAM_BOT_TOKEN=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)
  [ -z "$token" ] && continue

  bot_info=$(curl -s "https://api.telegram.org/bot${token}/getMe" 2>&1)
  if [ "$(echo "$bot_info" | jq -r '.ok' 2>/dev/null)" = "true" ]; then
    username=$(echo "$bot_info" | jq -r '.result.username')
    first_name=$(echo "$bot_info" | jq -r '.result.first_name')
    echo "  [$name] @${username} (${first_name})"
  else
    echo "  [$name] API error"
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
