# lib/config.sh — Config loading and validation for generate-agent.sh

REQUIRED_VARS=(
  "AGENT_NAME"
  "AGENT_DISPLAY_NAME"
  "AGENT_DIR"
  "PROJECT_DIR"
  "PROJECT_NAME"
  "PROJECT_DESCRIPTION"
  "TELEGRAM_BOT_TOKEN"
  "TELEGRAM_CHAT_ID"
  "ANTHROPIC_AUTH_TOKEN"
  "ANTHROPIC_BASE_URL"
  "GITHUB_REPO"
  "PROD_URL"
  "AGENT_USERNAME"
  "AGENT_ROLE"
)

load_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: Config file not found: $CONFIG_FILE"
    exit 1
  fi
  while IFS='=' read -r key value; do
    key=$(echo "$key" | xargs)
    [[ -z "$key" || "$key" == \#* ]] && continue
    value=$(echo "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
    export "$key=$value"
  done < "$CONFIG_FILE"
}

validate_config() {
  echo "Validating configuration..."
  local missing=0
  for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
      echo "  MISSING: $var"
      missing=$((missing + 1))
    fi
  done

  if [ "$missing" -gt 0 ]; then
    echo ""
    echo "ERROR: $missing required variable(s) missing."
    echo "Run with --interactive or fix the config file."
    exit 1
  fi
  echo "  All $(( ${#REQUIRED_VARS[@]} )) variables set."
}

# Set derived values after config is loaded + validated
set_derived() {
  CREATED_DATE=$(date -u +%Y-%m-%d)
}
