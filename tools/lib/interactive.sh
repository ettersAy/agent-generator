# lib/interactive.sh — Interactive prompts for generate-agent.sh
# Sources: ../lib/config.sh (for REQUIRED_VARS)

run_interactive() {
  echo "Interactive agent creation. Press Enter to accept defaults."
  echo "─────────────────────────────────────────────────────────"
  echo ""

  read -r -p "Agent name (kebab-case, e.g. 'my-app-bot'): " AGENT_NAME
  read -r -p "Agent display name (e.g. 'My App Bot'): " AGENT_DISPLAY_NAME
  read -r -p "Agent directory [/srv/dev/agents/${AGENT_NAME}]: " AGENT_DIR
  AGENT_DIR=${AGENT_DIR:-/srv/dev/agents/${AGENT_NAME}}
  read -r -p "Project directory [/srv/dev/${AGENT_NAME%-bot}]: " PROJECT_DIR
  PROJECT_DIR=${PROJECT_DIR:-/srv/dev/${AGENT_NAME%-bot}}
  read -r -p "Project short name: " PROJECT_NAME
  read -r -p "Project description (one line): " PROJECT_DESCRIPTION
  read -r -p "Telegram bot token: " TELEGRAM_BOT_TOKEN
  read -r -p "Telegram chat ID: " TELEGRAM_CHAT_ID
  read -r -p "Anthropic/DeepSeek auth token: " ANTHROPIC_AUTH_TOKEN
  read -r -p "Anthropic base URL [https://api.deepseek.com/anthropic]: " ANTHROPIC_BASE_URL
  ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-https://api.deepseek.com/anthropic}
  read -r -p "GitHub repo (owner/repo): " GITHUB_REPO
  read -r -p "Production URL: " PROD_URL
  read -r -p "Telegram bot username (e.g. @MyBot): " AGENT_USERNAME
  read -r -p "Agent role description (one line): " AGENT_ROLE

  # Write config file for reuse
  CONFIG_FILE="$GEN_DIR/.generated-config.env"
  {
    echo "# Agent Generator Config — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for var in "${REQUIRED_VARS[@]}"; do
      echo "${var}=${!var}"
    done
  } > "$CONFIG_FILE"
  echo ""
  echo "Config saved to: $CONFIG_FILE"
  echo ""
}
