# missions.sh — mission queue helpers for shell scripts
# Source after env.sh, logging.sh, and process.sh

# Count missions in a given directory
mission_count() {
  local dir="$1"
  ls "$dir"/*.md 2>/dev/null | wc -l
}

# Get basename without .md extension
mission_id() {
  basename "$1" .md
}

# Move mission to target directory with logging. No-op if already moved.
mission_move() {
  local src="$1" dst_dir="$2"
  if [ -f "$src" ]; then
    mv "$src" "$dst_dir/"
    log "$(mission_id "$src") → ${dst_dir##*/}/"
  fi
}

# Remove runner PID file for a mission
mission_cleanup_pid() {
  local basename="$1"
  rm -f "$PROGRESS_DIR/${basename}.pid"
}

# Check if runner for a mission is alive
mission_runner_alive() {
  local basename="$1"
  local pidfile="$PROGRESS_DIR/${basename}.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null) || true
    is_alive "$pid" && return 0
  fi
  return 1
}

# Get the result file path for a mission
mission_result_file() {
  local basename="$1"
  echo "$RESULTS_DIR/${basename}_result.md"
}

# Check if a result file exists and is non-empty
mission_has_result() {
  local basename="$1"
  local rf
  rf=$(mission_result_file "$basename")
  [ -f "$rf" ] && [ -s "$rf" ]
}

# Get mission file mtime as epoch seconds
mission_mtime() {
  local mission_file="$1"
  stat -c %Y "$mission_file" 2>/dev/null || echo 0
}
