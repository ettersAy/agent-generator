#!/usr/bin/env bash
# Mission Dispatcher — background daemon. Watches todo/, spawns runners.
# Each runner is nohup'd — survives dispatcher restart.
set -euo pipefail

# ── Load shared libraries ──────────────────────────────────────────────────
LIB_DIR="$(cd "$(dirname "$0")/../tools/lib" && pwd)"
source "$LIB_DIR/env.sh"
source "$LIB_DIR/logging.sh"
source "$LIB_DIR/process.sh"
source "$LIB_DIR/missions.sh"

LOG_TAG="dispatcher"
MAX_CONCURRENT=2
POLL_INTERVAL=5
STUCK_TIMEOUT_HOURS=4

# ── Shutdown ───────────────────────────────────────────────────────────────
cleanup() {
  log "Shutting down dispatcher..."
  remove_my_pid "$DISPATCHER_PID_FILE"
  log "Dispatcher stopped. Running Claude processes are NOT killed."
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── Dispatch a single mission ──────────────────────────────────────────────
dispatch_one() {
  local mission_file="$1"
  local bn
  bn=$(basename "$mission_file")

  local dest="$PROGRESS_DIR/$bn"
  mv "$mission_file" "$dest"
  log "Dispatching: $bn"

  nohup bash "$RUNNER_SCRIPT" "$dest" >> "$DISPATCH_LOG" 2>&1 &
  log "  Runner PID: $!"
}

# ── Handle orphaned mission (runner dead) ──────────────────────────────────
handle_orphan() {
  local basename="$1"
  local result_file="$2"

  if [ -f "$result_file" ] && [ -s "$result_file" ]; then
    log "  $basename → runner dead, result exists → recovering"
    local summary
    summary=$(head -c 800 "$result_file" | html_escape || echo "(no summary)")
    notify_tg "Mission result (recovered): ${basename:0:60}

${summary}"
    mission_move "$PROGRESS_DIR/${basename}.md" "$DONE_DIR"
  else
    log "  $basename → runner dead, no result → failed"
    notify_tg "Mission lost (runner crashed): ${basename:0:60}"
    mission_move "$PROGRESS_DIR/${basename}.md" "$FAILED_DIR"
  fi
  mission_cleanup_pid "$basename"
}

# ── Handle stuck mission (exceeded timeout) ────────────────────────────────
handle_stuck() {
  local basename="$1" age="$2"
  local result_file
  result_file=$(mission_result_file "$basename")

  log "  $basename → stuck (${age}s, runner dead) → failed"
  local tail_out=""
  if [ -f "$result_file" ]; then
    tail_out=$(tail -c 400 "$result_file" 2>/dev/null | html_escape || echo "")
  fi
  notify_tg "Mission timed out (${STUCK_TIMEOUT_HOURS}h): ${basename:0:60}

${tail_out}"
  mission_move "$PROGRESS_DIR/${basename}.md" "$FAILED_DIR"
  mission_cleanup_pid "$basename"
}

# ── Startup recovery: orphaned missions ────────────────────────────────────
recover_orphans() {
  log "Checking for orphaned in-progress missions..."

  for mf in "$PROGRESS_DIR"/*.md; do
    [ -f "$mf" ] || continue
    local bn
    bn=$(mission_id "$mf")

    if mission_runner_alive "$bn"; then
      log "  $bn → still running"
      continue
    fi

    handle_orphan "$bn" "$(mission_result_file "$bn")"
  done
}

# ── Check for stuck missions (exceeded timeout) ────────────────────────────
check_stuck() {
  local now
  now=$(date +%s)
  local timeout_sec=$((STUCK_TIMEOUT_HOURS * 3600))

  for mf in "$PROGRESS_DIR"/*.md; do
    [ -f "$mf" ] || continue
    local bn mtime age
    bn=$(mission_id "$mf")
    mtime=$(mission_mtime "$mf") || continue
    age=$((now - mtime))

    [ "$age" -le "$timeout_sec" ] && continue

    if mission_runner_alive "$bn"; then
      log "  $bn → long-running (${age}s), still alive — letting continue"
    else
      handle_stuck "$bn" "$age"
    fi
  done
}

# ── Dispatch pending missions (up to concurrency limit) ────────────────────
dispatch_pending() {
  local running available dispatched
  running=$(count_active_runners "$PROGRESS_DIR")
  available=$((MAX_CONCURRENT - running))

  [ "$available" -le 0 ] && return

  dispatched=0
  for mf in "$TODO_DIR"/*.md; do
    [ -f "$mf" ] || continue
    [ "$dispatched" -ge "$available" ] && break
    dispatch_one "$mf"
    dispatched=$((dispatched + 1))
  done
}

# ── Main ───────────────────────────────────────────────────────────────────
ensure_dirs
write_pid "$DISPATCHER_PID_FILE"

log "══════════════════════════════════════════════════════════════"
log "Mission Dispatcher started (PID $$)"
log "  TODO: $TODO_DIR  |  In-progress: $PROGRESS_DIR"
log "  Max concurrent: $MAX_CONCURRENT  |  Poll: ${POLL_INTERVAL}s  |  Stuck timeout: ${STUCK_TIMEOUT_HOURS}h"
log "══════════════════════════════════════════════════════════════"

recover_orphans

log "Entering dispatch loop..."
while true; do
  check_stuck
  dispatch_pending
  sleep "$POLL_INTERVAL"
done
