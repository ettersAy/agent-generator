#!/usr/bin/env bash
# Fast all-agents status check — PID files only, no API calls.
# Designed for instant response via /status-all Telegram command.
# Outputs formatted text ready for Telegram HTML display.
# Uses bash (not zsh) for predictable glob behavior.

REGISTRY="/srv/dev/agents/_shared/registry.txt"

# Status icons
STATUS_UP="🟢"
STATUS_DOWN="🔴"

# Detect output format
FORMAT="${1:-text}"

html() {
  if [ "$FORMAT" = "html" ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi
}

count_files() {
  local dir="$1" pattern="$2"
  if [ -d "$dir" ]; then
    find "$dir" -maxdepth 1 -name "$pattern" 2>/dev/null | wc -l
  else
    echo 0
  fi
}

# Header
if [ "$FORMAT" = "html" ]; then
  echo "<b>Agent Status Overview</b>"
  echo "━━━━━━━━━━━━━━━━━━━━"
else
  echo "Agent Status Overview"
  echo "===================="
fi
echo ""

# Track summary counts
total_agents=0
agents_up=0
agents_down=0
total_mailbox=0

while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac

  name=$(echo "$line" | awk '{print $1}')
  username=$(echo "$line" | awk '{print $2}')
  agent_dir=$(echo "$line" | awk '{print $3}')
  [ -z "$name" ] && continue
  total_agents=$((total_agents + 1))

  # Check server PID
  server_pid_file="$agent_dir/.telegram-server.pid"
  server_status="$STATUS_DOWN"
  server_pid=""
  if [ -f "$server_pid_file" ]; then
    server_pid=$(cat "$server_pid_file")
    if kill -0 "$server_pid" 2>/dev/null; then
      server_status="$STATUS_UP"
      agents_up=$((agents_up + 1))
    else
      agents_down=$((agents_down + 1))
    fi
  else
    agents_down=$((agents_down + 1))
  fi

  # Check bridge PID
  bridge_pid_file="$agent_dir/.agent-bridge.pid"
  bridge_status="$STATUS_DOWN"
  bridge_pid=""
  if [ -f "$bridge_pid_file" ]; then
    bridge_pid=$(cat "$bridge_pid_file")
    if kill -0 "$bridge_pid" 2>/dev/null; then
      bridge_status="$STATUS_UP"
    fi
  fi

  # Uptime
  uptime_str=""
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    uptime_str=$(ps -o etime= -p "$server_pid" 2>/dev/null | xargs)
    [ -n "$uptime_str" ] && uptime_str=" up $uptime_str"
  fi

  # Mission queue counts
  todo_count=$(count_files "$agent_dir/missions/todo" "*.md")
  inprog_count=$(count_files "$agent_dir/missions/in-progress" "*.md")
  done_count=$(count_files "$agent_dir/missions/done" "*.md")
  failed_count=$(count_files "$agent_dir/missions/failed" "*.md")

  # Mailbox pending
  mailbox_count=$(count_files "/srv/dev/agents/_shared/mailbox/$name/inbox" "*.json")
  total_mailbox=$((total_mailbox + mailbox_count))

  # Display
  if [ "$FORMAT" = "html" ]; then
    echo "<b>${name}</b> ${username} ${server_status}${uptime_str}"
    echo "  Server: ${server_status} PID ${server_pid:-none} | Bridge: ${bridge_status} PID ${bridge_pid:-none}"
    echo "  Queue: ⏳${todo_count} 🔄${inprog_count} ✅${done_count} ❌${failed_count} | Mailbox: ${mailbox_count}"
  else
    printf "%-18s %-20s %s%s\n" "$name" "$username" "$server_status" "$uptime_str"
    echo "  Server: ${server_status} PID ${server_pid:-none} | Bridge: ${bridge_status} PID ${bridge_pid:-none}"
    echo "  Queue: ${todo_count} todo | ${inprog_count} running | ${done_count} done | ${failed_count} failed | Mailbox: ${mailbox_count}"
  fi
  echo ""
done < "$REGISTRY"

# Summary line
if [ "$FORMAT" = "html" ]; then
  echo "━━━━━━━━━━━━━━━━━━━━"
  echo "<b>${total_agents} agents:</b> ${STATUS_UP} ${agents_up} running, ${STATUS_DOWN} ${agents_down} down | ${total_mailbox} pending messages"
else
  echo "===================="
  echo "${total_agents} agents: ${agents_up} running, ${agents_down} down | ${total_mailbox} pending messages"
fi
