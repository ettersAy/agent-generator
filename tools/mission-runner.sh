#!/usr/bin/env bash
# Mission Runner — executes a single mission via Claude CLI
# All output → disk (no memory accumulation). Notification sent post-exit.
# Usage: nohup bash tools/mission-runner.sh <path-to-mission-file.md> &
set -euo pipefail

MISSION_FILE="$1"

# ── Load shared libraries ──────────────────────────────────────────────────
LIB_DIR="$(cd "$(dirname "$0")" && pwd)/lib"
source "$LIB_DIR/env.sh"
load_env
source "$LIB_DIR/logging.sh"
source "$LIB_DIR/process.sh"
source "$LIB_DIR/missions.sh"

LOG_TAG="runner"
BASENAME=$(mission_id "$MISSION_FILE")
RESULT_FILE=$(mission_result_file "$BASENAME")

log "Starting mission: $BASENAME"
write_pid "$PROGRESS_DIR/${BASENAME}.pid"

# ── Build Claude prompt ────────────────────────────────────────────────────
# Claude inherits context from CLAUDE.md (loaded automatically from cwd).
PROMPT=$(cat <<PROMPT_EOF
Read and execute the mission file at: ${MISSION_FILE}

You are an AI agent with full authorization. Work autonomously — do NOT ask
for permission, just execute every task in the mission completely.

When the mission is fully complete, output a structured summary with:
## Accomplished — what was done
## Files Changed — files modified/created
## Verification — how to confirm the work
## Issues — any problems encountered (or "none")

Do not stop until the entire mission is complete. Use available tools freely.
PROMPT_EOF
)

# ── Execute Claude — output → file (zero memory) ───────────────────────────
log "Launching Claude CLI..."
START_TS=$(date +%s)

cd "$AGENT_DIR"
claude -p "$PROMPT" \
  --output-format text \
  --dangerously-skip-permissions \
  > "$RESULT_FILE" 2>&1

EXIT_CODE=$?
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
ELAPSED_MIN=$((ELAPSED / 60))
ELAPSED_SEC=$((ELAPSED % 60))

log "Claude exited: code=$EXIT_CODE elapsed=${ELAPSED_MIN}m${ELAPSED_SEC}s"

# ── Cleanup ────────────────────────────────────────────────────────────────
mission_cleanup_pid "$BASENAME"

# ── Handle result ──────────────────────────────────────────────────────────
if [ $EXIT_CODE -eq 0 ] && [ -s "$RESULT_FILE" ]; then
  notify_mission_done "$BASENAME" "$ELAPSED_MIN" "$ELAPSED_SEC" "$RESULT_FILE"
  mission_move "$MISSION_FILE" "$DONE_DIR"
  log "Mission complete: $BASENAME → done/"
else
  notify_mission_failed "$BASENAME" "$EXIT_CODE" "$ELAPSED_MIN" "$ELAPSED_SEC" "$RESULT_FILE"
  mission_move "$MISSION_FILE" "$FAILED_DIR"
  log "Mission failed: $BASENAME → failed/ (exit $EXIT_CODE)"
fi
