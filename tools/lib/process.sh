# process.sh — PID file and process management helpers
# Source after env.sh and logging.sh

# Check if a process by PID is alive
is_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Write a PID file (only if not already running with our PID)
write_pid() {
  local pid_file="$1"
  echo $$ > "$pid_file"
}

# Remove PID file if it contains our PID (prevents races during restarts)
remove_my_pid() {
  local pid_file="$1"
  if [ -f "$pid_file" ]; then
    local file_pid
    file_pid=$(cat "$pid_file" 2>/dev/null) || true
    if [ "$file_pid" = "$$" ]; then
      rm -f "$pid_file"
    fi
  fi
}

# Check if a service is running from its PID file
service_running() {
  local pid_file="$1"
  if [ -f "$pid_file" ]; then
    local pid
    pid=$(cat "$pid_file" 2>/dev/null) || true
    is_alive "$pid" && return 0
  fi
  return 1
}

# Get uptime string for a PID
uptime_for() {
  local pid="$1"
  ps -o etime= -p "$pid" 2>/dev/null | xargs || echo "?"
}

# Count children of a PID
child_count() {
  local pid="$1"
  pgrep -P "$pid" 2>/dev/null | wc -l
}

# Count active runner processes from .pid files in a directory
count_active_runners() {
  local pid_dir="$1"
  local count=0
  for pidfile in "$pid_dir"/*.pid; do
    [ -f "$pidfile" ] || continue
    local pid
    pid=$(cat "$pidfile" 2>/dev/null) || continue
    is_alive "$pid" && count=$((count + 1))
  done
  echo "$count"
}
