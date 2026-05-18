#!/usr/bin/env zsh
# Restart the Unified Telegram Bot Server (all agents).
set -e
HUB_DIR="/srv/dev/agents/agent-generator"
echo "Restarting unified Telegram server..."
"$HUB_DIR/scripts/telegram-stop.sh"
sleep 1
"$HUB_DIR/scripts/telegram-start.sh"
