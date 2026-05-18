#!/usr/bin/env bash
# mission-summary.sh — Print a summary of the most recent mission(s)
# Usage:
#   ./tools/mission-summary.sh           # Last mission
#   ./tools/mission-summary.sh -n 3      # Last 3 missions
#   ./tools/mission-summary.sh -a        # All missions
#
# Searches: missions/done/, missions/failed/, missions/in-progress/, missions/todo/

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
MISSIONS_DIR="$AGENT_DIR/missions"
COUNT=1
ALL=false

# ── Parse arguments ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) COUNT="$2"; shift 2 ;;
    -a) ALL=true; shift ;;
    -h|--help)
      echo "Usage: mission-summary.sh [-n N] [-a]"
      echo "  -n N   Show last N missions (default: 1)"
      echo "  -a     Show all missions"
      exit 0
      ;;
    *) shift ;;
  esac
done

# ── Collect all mission files sorted by date (newest first) ───────────────────
MISSION_FILES=()
for dir in done failed in-progress todo; do
  dir_path="$MISSIONS_DIR/$dir"
  if [ -d "$dir_path" ]; then
    for f in "$dir_path"/*.md; do
      [ -f "$f" ] || continue
      MISSION_FILES+=("$f")
    done
  fi
done

if [ ${#MISSION_FILES[@]} -eq 0 ]; then
  echo "No missions found."
  exit 0
fi

sorted=()
while IFS= read -r line; do
  sorted+=("$line")
done < <(printf '%s\n' "${MISSION_FILES[@]}" | sort -r)

if [ "$ALL" = false ] && [ "$COUNT" -lt "${#sorted[@]}" ]; then
  sorted=("${sorted[@]:0:$COUNT}")
fi

# ── Extract field value from a mission metadata table ─────────────────────────
# Format: | **Key** | Value |
extract() {
  local key="$1" file="$2" line
  line=$(grep -P "\\|\\s*\\*\\*${key}\\*\\*\\s*\\|" "$file" 2>/dev/null | head -1)
  if [ -n "$line" ]; then
    # Remove leading | **Key** | and trailing |
    echo "$line" | sed -E 's/^\|\s*\*\*'"$key"'\*\*\s*\|\s*//;s/\s*\|\s*$//'
  fi
}

# ── Print summaries ──────────────────────────────────────────────────────────
first=true
for file in "${sorted[@]}"; do
  if [ "$first" = true ]; then
    first=false
  else
    echo ""
    echo "────────────────────────────────────────────────────────────────────────────"
    echo ""
  fi

  status_from_path=$(basename "$(dirname "$file")")
  title=$(head -1 "$file" | sed 's/^# Mission: //')
  created=$(extract "Created" "$file")
  file_status=$(extract "Status" "$file")
  source=$(extract "Source" "$file")

  # Request body: content between ## Original Request and next ## section
  request=$(sed -n '/^## Original Request/,/^##/p' "$file" \
    | sed '1d' \
    | sed '/^## Progress/d; /^## Plan/d; /^## Resolution/d' \
    | sed '/^$/d' \
    | head -20)
  request_first="$(echo "$request" | head -1)"
  request_rest="$(echo "$request" | tail -n +2)"

  # Resolution (only in done/failed)
  resolution=$(sed -n '/^## Resolution/,/^##/p' "$file" 2>/dev/null \
    | sed '1d' \
    | sed '/^##/d' \
    | sed '/^$/d' \
    | head -20)
  resolution_first="$(echo "$resolution" | head -1)"
  resolution_rest="$(echo "$resolution" | tail -n +2)"

  # Last progress event
  last_event=$(sed -n '/^## Progress Log/,/^$/p' "$file" 2>/dev/null \
    | grep -E '^\|.*\|.*\|' \
    | tail -1 \
    | sed -E 's/^\|\s*//; s/\s*\|\s*/  /g; s/\s*\|\s*$//')

  status="${file_status:-$status_from_path}"

  printf "Title:       %s\n" "$title"
  printf "Status:      %s\n" "$status"
  printf "Created:     %s\n" "$created"
  [ -n "$source" ] && printf "Source:      %s\n" "$source"
  echo ""
  if [ -n "$request_first" ]; then
    printf "Request:     %s\n" "$request_first"
    if [ -n "$request_rest" ]; then
      echo "$request_rest" | while IFS= read -r line; do printf "             %s\n" "$line"; done
    fi
  fi
  if [ -n "$last_event" ]; then
    echo ""
    echo "Last event:  $last_event"
  fi
  if [ -n "$resolution_first" ]; then
    echo ""
    printf "Resolution:  %s\n" "$resolution_first"
    if [ -n "$resolution_rest" ]; then
      echo "$resolution_rest" | while IFS= read -r line; do printf "             %s\n" "$line"; done
    fi
  fi
done

echo ""
echo "── Showing ${#sorted[@]} of ${#MISSION_FILES[@]} missions (done/failed/in-progress/todo) ──"
for d in done failed in-progress todo; do
  c=$(find "$MISSIONS_DIR/$d" -name "*.md" -type f 2>/dev/null | wc -l)
  echo "   $d: $c"
done
