# env.sh — environment loading for shell scripts
# Source this file, then call load_env to get AGENT_DIR, config paths, and env vars.

# All scripts live under AGENT_DIR; derive if not set
if [ -z "${AGENT_DIR:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  AGENT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

load_env() {
  if [ -f "$AGENT_DIR/.env" ]; then
    set -a; source "$AGENT_DIR/.env"; set +a
  fi
}

# Standard paths derived from AGENT_DIR
TODO_DIR="$AGENT_DIR/missions/todo"
PROGRESS_DIR="$AGENT_DIR/missions/in-progress"
DONE_DIR="$AGENT_DIR/missions/done"
FAILED_DIR="$AGENT_DIR/missions/failed"
RESULTS_DIR="$AGENT_DIR/missions/results"
LOGS_DIR="$AGENT_DIR/logs"
DISPATCH_LOG="$LOGS_DIR/dispatcher.log"
NOTIFY_SCRIPT="$AGENT_DIR/tools/telegram-send.sh"
RUNNER_SCRIPT="$AGENT_DIR/tools/mission-runner.sh"
DISPATCHER_PID_FILE="$AGENT_DIR/.mission-dispatcher.pid"
SERVER_PID_FILE="$AGENT_DIR/.unified-server.pid"

ensure_dirs() {
  mkdir -p "$TODO_DIR" "$PROGRESS_DIR" "$DONE_DIR" "$FAILED_DIR" "$RESULTS_DIR" "$LOGS_DIR"
}
