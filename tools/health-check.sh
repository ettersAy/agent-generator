#!/usr/bin/env bash
# health-check.sh — Comprehensive AI agent ecosystem health check.
# Single command to assess all agents, bridges, dispatchers, orphans, and mailboxes.
#
# Usage:
#   health-check.sh              Full report
#   health-check.sh --json       Machine-readable JSON output
#   health-check.sh --fix        Auto-fix stale PIDs and orphaned missions
#   health-check.sh --compact    One-line summary

set -euo pipefail

SHARED_DIR="/srv/dev/agents/_shared"
REGISTRY_FILE="$SHARED_DIR/registry.txt"
MAILBOX_DIR="$SHARED_DIR/mailbox"
AGENT_GEN_DIR="/srv/dev/agents/agent-generator"
OUTPUT_FORMAT="${1:-}"

# ── Helpers ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

ts() { date -Iseconds; }

is_pid_alive() {
  kill -0 "$1" 2>/dev/null
}

agent_from_registry() {
  # Returns all agent names from registry
  grep -v '^#' "$REGISTRY_FILE" | grep -v '^$' | awk '{print $1}'
}

agent_dir() {
  grep "^$1 " "$REGISTRY_FILE" | awk '{print $3}'
}

agent_username() {
  grep "^$1 " "$REGISTRY_FILE" | awk '{print $2}'
}

# ── Per-Agent Checks ─────────────────────────────────────────────────────────
check_agent() {
  local name="$1" dir="$2"
  local server_ok=false bridge_ok=false server_pid="" bridge_pid=""

  if [ -f "$dir/.telegram-server.pid" ]; then
    server_pid=$(cat "$dir/.telegram-server.pid")
    is_pid_alive "$server_pid" && server_ok=true
  fi

  if [ -f "$dir/.agent-bridge.pid" ]; then
    bridge_pid=$(cat "$dir/.agent-bridge.pid")
    is_pid_alive "$bridge_pid" && bridge_ok=true
  fi

  local missions_dir="$dir/missions"
  local todo=0 inprog=0 done=0 failed=0
  for s in todo in-progress done failed; do
    local d="$missions_dir/$s"
    local count=0
    [ -d "$d" ] && count=$(ls "$d"/*.md 2>/dev/null | wc -l)
    case "$s" in
      todo) todo=$count ;;
      in-progress) inprog=$count ;;
      done) done=$count ;;
      failed) failed=$count ;;
    esac
  done

  # Detect orphans: .pid files in in-progress/ with no .md or dead process
  local orphans=0
  local orphan_list=""
  if [ -d "$missions_dir/in-progress" ]; then
    for pidfile in "$missions_dir/in-progress/"*.pid; do
      [ -f "$pidfile" ] || continue
      local bn=$(basename "$pidfile" .pid)
      local rpid=$(cat "$pidfile" 2>/dev/null || echo "0")
      if [ ! -f "$missions_dir/in-progress/$bn.md" ] && [ ! -f "$missions_dir/done/$bn.md" ]; then
        # PID file without a mission file — orphan
        if ! is_pid_alive "$rpid" 2>/dev/null; then
          orphans=$((orphans + 1))
          orphan_list="$orphan_list $bn"
        fi
      elif ! is_pid_alive "$rpid" 2>/dev/null; then
        # Runner dead but .md still in-progress
        orphans=$((orphans + 1))
        orphan_list="$orphan_list $bn"
      fi
    done
  fi

  echo "$server_ok|$bridge_ok|$server_pid|$bridge_pid|$todo|$inprog|$done|$failed|$orphans|$orphan_list"
}

check_mailbox() {
  local agent="$1"
  local inbox="$MAILBOX_DIR/$agent/inbox"
  local count=0
  [ -d "$inbox" ] && count=$(ls "$inbox"/*.json 2>/dev/null | wc -l)
  echo "$count"
}

# ── Unified Server / Dispatcher ──────────────────────────────────────────────
check_ag_server() {
  local running=false pid=""
  if [ -f "$AGENT_GEN_DIR/.unified-server.pid" ]; then
    pid=$(cat "$AGENT_GEN_DIR/.unified-server.pid")
    is_pid_alive "$pid" && running=true
  fi
  echo "$running|$pid"
}

check_ag_dispatcher() {
  local running=false pid=""
  if [ -f "$AGENT_GEN_DIR/.mission-dispatcher.pid" ]; then
    pid=$(cat "$AGENT_GEN_DIR/.mission-dispatcher.pid")
    is_pid_alive "$pid" && running=true
  fi
  echo "$running|$pid"
}

# ── Auto-Fix ─────────────────────────────────────────────────────────────────
auto_fix() {
  local fixed=0
  echo "Auto-fixing..."

  # Clean stale PID files across all agents
  for name in $(agent_from_registry); do
    local dir
    dir=$(agent_dir "$name")
    [ -z "$dir" ] && continue

    # Stale server PID
    if [ -f "$dir/.telegram-server.pid" ]; then
      local spid=$(cat "$dir/.telegram-server.pid")
      if ! is_pid_alive "$spid"; then
        rm -f "$dir/.telegram-server.pid"
        echo "  [$name] cleaned stale server PID ($spid)"
        fixed=$((fixed + 1))
      fi
    fi

    # Stale bridge PID
    if [ -f "$dir/.agent-bridge.pid" ]; then
      local bpid=$(cat "$dir/.agent-bridge.pid")
      if ! is_pid_alive "$bpid"; then
        rm -f "$dir/.agent-bridge.pid"
        echo "  [$name] cleaned stale bridge PID ($bpid)"
        fixed=$((fixed + 1))
      fi
    fi

    # Orphaned .pid files in in-progress (no .md file in in-progress/ or done/)
    local missions_dir="$dir/missions"
    if [ -d "$missions_dir/in-progress" ]; then
      for pidfile in "$missions_dir/in-progress/"*.pid; do
        [ -f "$pidfile" ] || continue
        local bn=$(basename "$pidfile" .pid)
        local rpid=$(cat "$pidfile" 2>/dev/null || echo "0")
        if ! is_pid_alive "$rpid"; then
          # Runner is dead — clean up
          if [ -f "$missions_dir/results/${bn}_result.md" ] || [ -f "$missions_dir/done/${bn}.md" ]; then
            # Result exists — mission completed, just cleanup
            rm -f "$pidfile"
            echo "  [$name] cleaned orphan PID: $bn (mission completed)"
            fixed=$((fixed + 1))
          elif [ -f "$missions_dir/in-progress/${bn}.md" ]; then
            # Mission file still in-progress but runner dead — move to failed
            mkdir -p "$missions_dir/failed"
            mv "$missions_dir/in-progress/${bn}.md" "$missions_dir/failed/${bn}.md"
            rm -f "$pidfile"
            echo "  [$name] moved to failed: $bn (runner dead, no result)"
            fixed=$((fixed + 1))
          else
            # Stale PID only
            rm -f "$pidfile"
            echo "  [$name] cleaned orphan PID: $bn"
            fixed=$((fixed + 1))
          fi
        fi
      done
    fi
  done

  # Clean agent-generator's own stale PIDs
  for f in "$AGENT_GEN_DIR/.unified-server.pid" "$AGENT_GEN_DIR/.mission-dispatcher.pid"; do
    if [ -f "$f" ]; then
      local pid=$(cat "$f")
      if ! is_pid_alive "$pid"; then
        rm -f "$f"
        echo "  [agent-generator] cleaned stale $(basename "$f") ($pid)"
        fixed=$((fixed + 1))
      fi
    fi
  done

  echo "Fixed $fixed issues."
  return "$fixed"
}

# ── JSON Output ──────────────────────────────────────────────────────────────
output_json() {
  local ag_server ag_server_pid ag_disp ag_disp_pid
  IFS='|' read -r ag_server ag_server_pid <<< "$(check_ag_server)"
  IFS='|' read -r ag_disp ag_disp_pid <<< "$(check_ag_dispatcher)"

  echo "{"
  echo "  \"timestamp\": \"$(ts)\","
  echo "  \"agent_generator\": {"
  echo "    \"unified_server\": $ag_server,"
  echo "    \"unified_server_pid\": \"$ag_server_pid\","
  echo "    \"dispatcher\": $ag_disp,"
  echo "    \"dispatcher_pid\": \"$ag_disp_pid\""
  echo "  },"
  echo "  \"agents\": ["

  local first=true
  for name in $(agent_from_registry); do
    local dir username
    dir=$(agent_dir "$name")
    username=$(agent_username "$name")

    local server_ok bridge_ok server_pid bridge_pid todo inprog done_cnt failed_cnt orphans orphan_list
    IFS='|' read -r server_ok bridge_ok server_pid bridge_pid todo inprog done_cnt failed_cnt orphans orphan_list <<< "$(check_agent "$name" "$dir")"

    local mbox_count
    mbox_count=$(check_mailbox "$name")

    $first || echo ","
    first=false
    echo -n "    {"
    echo -n "\"name\": \"$name\", \"username\": \"$username\", "
    echo -n "\"server_ok\": $server_ok, \"bridge_ok\": $bridge_ok, "
    echo -n "\"server_pid\": \"$server_pid\", \"bridge_pid\": \"$bridge_pid\", "
    echo -n "\"missions\": {\"todo\": $todo, \"in_progress\": $inprog, \"done\": $done_cnt, \"failed\": $failed_cnt}, "
    echo -n "\"orphans\": $orphans, \"mailbox_pending\": $mbox_count"
    echo -n "}"
  done

  echo ""
  echo "  ],"
  echo "  \"summary\": {"
  echo "    \"total_agents\": $(agent_from_registry | wc -l),"
  echo "    \"healthy_agents\": $(for n in $(agent_from_registry); do dir=$(agent_dir "$n"); check_agent "$n" "$dir" | grep -q "^true\|true" && echo 1; done | wc -l),"
  echo "    \"total_orphans\": $(for n in $(agent_from_registry); do dir=$(agent_dir "$n"); check_agent "$n" "$dir" | cut -d'|' -f9; done | paste -sd+ | bc 2>/dev/null || echo 0),"
  echo "    \"total_mailbox_pending\": $(for n in $(agent_from_registry); do check_mailbox "$n"; done | paste -sd+ | bc 2>/dev/null || echo 0)"
  echo "  }"
  echo "}"
}

# ── Compact Output ───────────────────────────────────────────────────────────
output_compact() {
  local ok=0 total=0
  for name in $(agent_from_registry); do
    total=$((total + 1))
    local dir username
    dir=$(agent_dir "$name")
    username=$(agent_username "$name")

    local server_ok bridge_ok server_pid bridge_pid todo inprog done_cnt failed_cnt orphans orphan_list
    IFS='|' read -r server_ok bridge_ok server_pid bridge_pid todo inprog done_cnt failed_cnt orphans orphan_list <<< "$(check_agent "$name" "$dir")"

    local mbox
    mbox=$(check_mailbox "$name")

    if $server_ok && $bridge_ok; then
      ok=$((ok + 1))
      echo -e "${GREEN}✓${NC} $name ($username) server:$server_pid bridge:$bridge_pid mbox:$mbox"
    else
      echo -e "${RED}✗${NC} $name ($username) server:$server_ok bridge:$bridge_ok orphans:$orphans mbox:$mbox"
    fi
  done

  echo ""
  local ag_server ag_disp
  IFS='|' read -r ag_server _ <<< "$(check_ag_server)"
  IFS='|' read -r ag_disp _ <<< "$(check_ag_dispatcher)"
  echo "Hub: server=$ag_server dispatcher=$ag_disp | $ok/$total agents healthy"
}

# ── Default (Full) Output ────────────────────────────────────────────────────
output_full() {
  echo "══════════════════════════════════════════════════════════════"
  echo "  AI Agent Ecosystem — Health Check"
  echo "  $(date)"
  echo "══════════════════════════════════════════════════════════════"

  # ── Agent Generator Hub ──
  echo ""
  echo "── Hub (Agent Generator) ──"
  local ag_server ag_server_pid ag_disp ag_disp_pid
  IFS='|' read -r ag_server ag_server_pid <<< "$(check_ag_server)"
  IFS='|' read -r ag_disp ag_disp_pid <<< "$(check_ag_dispatcher)"

  if $ag_server; then
    echo -e "  Unified Server:  ${GREEN}RUNNING${NC} (PID $ag_server_pid)"
  else
    echo -e "  Unified Server:  ${RED}DEAD${NC} (stale PID $ag_server_pid)"
  fi

  if $ag_disp; then
    echo -e "  Dispatcher:      ${GREEN}RUNNING${NC} (PID $ag_disp_pid)"
  else
    echo -e "  Dispatcher:      ${RED}DEAD${NC} (stale PID $ag_disp_pid)"
  fi

  # ── Agents ──
  echo ""
  echo "── Agents ──"
  local total_ok=0 total_agents=0 total_orphans=0 total_mbox=0

  for name in $(agent_from_registry); do
    total_agents=$((total_agents + 1))
    local dir username
    dir=$(agent_dir "$name")
    username=$(agent_username "$name")

    local server_ok bridge_ok server_pid bridge_pid todo inprog done_cnt failed_cnt orphans orphan_list
    IFS='|' read -r server_ok bridge_ok server_pid bridge_pid todo inprog done_cnt failed_cnt orphans orphan_list <<< "$(check_agent "$name" "$dir")"

    local mbox
    mbox=$(check_mailbox "$name")
    total_mbox=$((total_mbox + mbox))
    total_orphans=$((total_orphans + orphans))

    # Status icons
    local s_icon b_icon health_icon
    $server_ok && s_icon="${GREEN}✅${NC}" || s_icon="${RED}❌${NC}"
    $bridge_ok && b_icon="${GREEN}✅${NC}" || b_icon="${RED}❌${NC}"

    if $server_ok && $bridge_ok && [ "$orphans" -eq 0 ]; then
      health_icon="${GREEN}HEALTHY${NC}"
      total_ok=$((total_ok + 1))
    elif $server_ok || $bridge_ok; then
      health_icon="${YELLOW}DEGRADED${NC}"
    else
      health_icon="${RED}OFFLINE${NC}"
    fi

    printf "  %-16s %-14s  server:%s  bridge:%s  [%s]\n" "$name" "$username" "$s_icon" "$b_icon" "$health_icon"
    printf "    Missions: todo=%-2d  in-progress=%-2d  done=%-2d  failed=%-2d\n" "$todo" "$inprog" "$done_cnt" "$failed_cnt"

    if [ "$orphans" -gt 0 ]; then
      echo -e "    ${YELLOW}⚠ Orphans: $orphans${NC}$orphan_list"
    fi
    if [ "$mbox" -gt 0 ]; then
      echo -e "    ${YELLOW}📬 Mailbox: $mbox pending${NC}"
    fi
  done

  # ── Summary ──
  echo ""
  echo "── Summary ──"
  echo "  Agents: $total_ok/$total_agents healthy"
  echo "  Orphaned missions: $total_orphans"
  echo "  Pending mailbox messages: $total_mbox"

  if [ "$total_orphans" -gt 0 ] || [ "$total_ok" -lt "$total_agents" ]; then
    echo ""
    echo -e "  ${YELLOW}⚠ Issues detected — run with --fix to auto-clean${NC}"
  fi

  echo ""
  echo "══════════════════════════════════════════════════════════════"
}

# ── Main ─────────────────────────────────────────────────────────────────────
case "${1:-}" in
  --json)
    output_json
    ;;
  --compact)
    output_compact
    ;;
  --fix)
    auto_fix
    echo ""
    output_compact
    ;;
  *)
    output_full
    ;;
esac
