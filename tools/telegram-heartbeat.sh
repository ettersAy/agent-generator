#!/usr/bin/env bash
# Mission heartbeat — send a quick status ping to the user via Telegram.
# Used during long-running missions to keep the user informed.
#
# Usage: bash tools/telegram-heartbeat.sh "status message"
# Alias:  tg-update "status message"

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/telegram-send.sh" "$1"
