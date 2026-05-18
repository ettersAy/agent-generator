#!/usr/bin/env bash
# agent-generator Telegram Inbox — View and manage incoming Telegram messages.
# Usage:
#   ./tools/telegram-inbox.sh              Show unreplied messages
#   ./tools/telegram-inbox.sh --all        Show all messages
#   ./tools/telegram-inbox.sh --replied    Show replied messages
#   ./tools/telegram-inbox.sh --stats      Show counts
#   ./tools/telegram-inbox.sh --mark ID    Mark message as replied

set -e

AGENT_DIR="/srv/dev/agents/agent-generator"
INBOX_FILE="$AGENT_DIR/logs/messages.jsonl"

if [ ! -f "$INBOX_FILE" ]; then
  echo "📭 No messages yet. Inbox file doesn't exist."
  echo "   Path: $INBOX_FILE"
  exit 0
fi

# Count messages (awk avoids grep -c || echo 0 double-output bug)
TOTAL=$(wc -l < "$INBOX_FILE")
UNREPLIED=$(awk '/"replied":false/{c++} END{print c+0}' "$INBOX_FILE")
REPLIED=$((TOTAL - UNREPLIED))

case "${1:-}" in
  --all)
    echo "📬 All messages ($TOTAL total):"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    while IFS= read -r line; do
      echo "$line" | jq -r '"  [#\(.update_id)] \(.timestamp) | \(.from) | \(.text) | \(if .replied then "✅ replied" else "⏳ pending" end)"' 2>/dev/null
    done < "$INBOX_FILE"
    ;;

  --replied)
    echo "✅ Replied messages ($REPLIED):"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    grep '"replied":true' "$INBOX_FILE" | while IFS= read -r line; do
      echo "$line" | jq -r '"  [#\(.update_id)] \(.timestamp) | \(.from) | \(.text)"' 2>/dev/null
    done
    ;;

  --stats)
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Telegram Inbox Statistics"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  📁 Inbox file: $INBOX_FILE"
    echo "  📊 Total messages:  $TOTAL"
    echo "  ⏳ Unreplied:       $UNREPLIED"
    echo "  ✅ Replied:         $REPLIED"
    echo ""
    if [ "$UNREPLIED" -gt 0 ]; then
      echo "  ── Latest unreplied ──"
      grep '"replied":false' "$INBOX_FILE" | tail -3 | while IFS= read -r line; do
        echo "$line" | jq -r '"  [#\(.update_id)] \(.timestamp) | \(.from): \(.text)"' 2>/dev/null
      done
    fi
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  --mark)
    ID="$2"
    if [ -z "$ID" ]; then
      echo "Usage: telegram-inbox.sh --mark <update_id>"
      exit 1
    fi
    # Mark message as replied using a temp file
    TMPFILE=$(mktemp)
    while IFS= read -r line; do
      UID=$(echo "$line" | jq -r '.update_id' 2>/dev/null)
      if [ "$UID" = "$ID" ]; then
        echo "$line" | jq -c '.replied = true' >> "$TMPFILE"
      else
        echo "$line" >> "$TMPFILE"
      fi
    done < "$INBOX_FILE"
    mv "$TMPFILE" "$INBOX_FILE"
    echo "✅ Marked message $ID as replied"
    ;;

  *)
    # Default: show unreplied
    if [ "$UNREPLIED" -eq 0 ]; then
      echo "✅ No pending messages. ($TOTAL total, all replied)"
    else
      echo "⏳ Pending messages ($UNREPLIED unreplied, $TOTAL total):"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      grep '"replied":false' "$INBOX_FILE" | while IFS= read -r line; do
        echo "$line" | jq -r '"  [#\(.update_id)] \(.timestamp) | \(.from): \(.text)"' 2>/dev/null
      done
      echo ""
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo "To mark as replied: ./tools/telegram-inbox.sh --mark <update_id>"
    fi
    ;;
esac
