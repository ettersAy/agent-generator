# logging.sh — structured logging and Telegram notification helpers
# Source after env.sh

# ── Logging ────────────────────────────────────────────────────────────────
log()  { echo "[$(date -Iseconds)] [${LOG_TAG:-main}] $*"; }
log_err() { echo "[$(date -Iseconds)] [${LOG_TAG:-main}] ERROR $*" >&2; }

# ── HTML escaping (Telegram's parse_mode=HTML requires this) ───────────────
html_escape() {
  if [ $# -gt 0 ]; then
    sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' <<< "${1:-}"
  elif [ ! -t 0 ]; then
    sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'
  else
    echo ""
  fi
}

# ── Telegram notification ──────────────────────────────────────────────────
# Sends a message to the configured Telegram chat. Never fails the caller.
notify_tg() {
  local msg="$1"
  bash "$NOTIFY_SCRIPT" "$msg" 2>/dev/null || true
}

# Send mission-complete notification with result excerpt
notify_mission_done() {
  local basename="$1" elapsed_min="$2" elapsed_sec="$3" result_file="$4"
  local summary
  summary=$(head -c 1200 "$result_file" 2>/dev/null | html_escape || echo "(no result)")
  notify_tg "Mission complete (${elapsed_min}m${elapsed_sec}s)

${summary}"
}

# Send mission-failed notification with error excerpt
notify_mission_failed() {
  local basename="$1" exit_code="$2" elapsed_min="$3" elapsed_sec="$4" result_file="$5"
  local err_tail
  err_tail=$(tail -c 500 "$result_file" 2>/dev/null | html_escape || echo "(no output)")
  notify_tg "Mission FAILED (exit ${exit_code}, ${elapsed_min}m${elapsed_sec}s)

Last output:
${err_tail}"
}
