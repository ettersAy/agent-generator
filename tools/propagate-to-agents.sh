#!/usr/bin/env bash
# propagate-to-agents.sh — Apply a block of text to all agent CLAUDE.md files.
# Idempotent: checks for an anchor string before inserting, so it never duplicates.
#
# Usage:
#   propagate-to-agents.sh --block-file <file> --anchor <string> --after <pattern>
#   propagate-to-agents.sh --block-file <file> --anchor <string> --before <pattern>
#
# Example:
#   echo "## My Section\nContent here" > /tmp/block.md
#   propagate-to-agents.sh --block-file /tmp/block.md --anchor "## My Section" --before "## The.*Project"
#
# --anchor   : If this string exists in the CLAUDE.md, the block is already present (skip).
# --after    : Insert block AFTER the line matching this regex.
# --before   : Insert block BEFORE the line matching this regex (and the preceding ---).
# --dry-run  : Show what would change without writing.
# --test     : After applying, send a test message to each agent via inter-agent.

set -euo pipefail

SHARED_DIR="/srv/dev/agents/_shared"
REGISTRY_FILE="$SHARED_DIR/registry.txt"
BLOCK_FILE=""
ANCHOR=""
AFTER=""
BEFORE=""
DRY_RUN=false
DO_TEST=false

while [ $# -gt 0 ]; do
  case "$1" in
    --block-file) BLOCK_FILE="$2"; shift 2 ;;
    --anchor) ANCHOR="$2"; shift 2 ;;
    --after) AFTER="$2"; shift 2 ;;
    --before) BEFORE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --test) DO_TEST=true; shift ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

if [ -z "$BLOCK_FILE" ] || [ -z "$ANCHOR" ]; then
  echo "Usage: propagate-to-agents.sh --block-file <file> --anchor <string> [--after <pattern>|--before <pattern>] [--dry-run] [--test]"
  exit 1
fi

if [ ! -f "$BLOCK_FILE" ]; then
  echo "Block file not found: $BLOCK_FILE"
  exit 1
fi

BLOCK=$(cat "$BLOCK_FILE")

# ── Find all agents ──────────────────────────────────────────────────────────
UPDATED=0
SKIPPED=0
RESULTS=""

for name in $(grep -v '^#' "$REGISTRY_FILE" | grep -v '^$' | awk '{print $1}'); do
  dir=$(grep "^$name " "$REGISTRY_FILE" | awk '{print $3}')
  claude_md="$dir/CLAUDE.md"

  if [ ! -f "$claude_md" ]; then
    RESULTS="${RESULTS}  ${name}: no CLAUDE.md — skip\n"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Idempotency check
  if grep -qF "$ANCHOR" "$claude_md" 2>/dev/null; then
    RESULTS="${RESULTS}  ${name}: already present — skip\n"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if $DRY_RUN; then
    RESULTS="${RESULTS}  ${name}: would update\n"
    UPDATED=$((UPDATED + 1))
    continue
  fi

  # Apply the block
  if [ -n "$BEFORE" ]; then
    # Insert block before the matched pattern (and the preceding --- divider)
    awk -v block="$BLOCK" -v pattern="$BEFORE" '
      $0 ~ pattern && !done {
        print block
        done = 1
      }
      { print }
    ' "$claude_md" > "${claude_md}.tmp" && mv "${claude_md}.tmp" "$claude_md"
  elif [ -n "$AFTER" ]; then
    # Insert block after the matched pattern
    awk -v block="$BLOCK" -v pattern="$AFTER" '
      { print }
      $0 ~ pattern && !done {
        print ""
        print block
        done = 1
      }
    ' "$claude_md" > "${claude_md}.tmp" && mv "${claude_md}.tmp" "$claude_md"
  fi

  RESULTS="${RESULTS}  ${name}: updated\n"
  UPDATED=$((UPDATED + 1))
done

# ── Template ─────────────────────────────────────────────────────────────────
TEMPLATE="/srv/dev/agents/agent-generator/templates/CLAUDE.md.tmpl"
if [ -f "$TEMPLATE" ]; then
  if grep -qF "$ANCHOR" "$TEMPLATE" 2>/dev/null; then
    RESULTS="${RESULTS}  template: already present — skip\n"
    SKIPPED=$((SKIPPED + 1))
  else
    if $DRY_RUN; then
      RESULTS="${RESULTS}  template: would update\n"
    else
      if [ -n "$BEFORE" ]; then
        awk -v block="$BLOCK" -v pattern="$BEFORE" '
          $0 ~ pattern && !done { print block; done = 1 }
          { print }
        ' "$TEMPLATE" > "${TEMPLATE}.tmp" && mv "${TEMPLATE}.tmp" "$TEMPLATE"
      elif [ -n "$AFTER" ]; then
        awk -v block="$BLOCK" -v pattern="$AFTER" '
          { print }
          $0 ~ pattern && !done { print ""; print block; done = 1 }
        ' "$TEMPLATE" > "${TEMPLATE}.tmp" && mv "${TEMPLATE}.tmp" "$TEMPLATE"
      fi
      RESULTS="${RESULTS}  template: updated\n"
    fi
    UPDATED=$((UPDATED + 1))
  fi
fi

echo ""
echo "═══ Propagation Report ═══"
echo "  Updated: $UPDATED"
echo "  Skipped: $SKIPPED"
echo -e "$RESULTS"

# ── Test agents ──────────────────────────────────────────────────────────────
if $DO_TEST; then
  echo ""
  echo "═══ Testing agents via inter-agent ───"
  for name in $(grep -v '^#' "$REGISTRY_FILE" | grep -v '^$' | awk '{print $1}'); do
    [[ "$name" == "agent-generator" ]] && continue
    MAILBOX_DIR="$SHARED_DIR/mailbox"
    inbox="$MAILBOX_DIR/$name/inbox"
    mkdir -p "$inbox"
    test_msg="$SHARED_DIR/mailbox/$name/inbox/$(date -Iseconds)-agent-generator-propagation-test.json"
    cat > "$test_msg" <<EOFMSG
{
  "id": "propagation-test-$(date +%s)",
  "from": "agent-generator",
  "to": "$name",
  "timestamp": "$(date -Iseconds)",
  "type": "question",
  "subject": "Verify: can you use shared tools?",
  "body": "This is an automated test from agent-generator. Please confirm:\\n1. You can access shared tools at /srv/dev/agents/_shared/tools/\\n2. Run: bash /srv/dev/agents/_shared/tools/health-check.sh --compact\\n3. Reply with the output."
}
EOFMSG
    echo "  Sent test to $name"
  done
  echo "  Check inboxes for responses in ~30s."
fi
