# lib/generate.sh — Template engine and agent generation
# Requires: AGENT_DIR, PROJECT_DIR, AGENT_DISPLAY_NAME, etc. to be set

TEMPLATES_DIR="$GEN_DIR/templates"

# Template files → output mapping: "template_relative_path|output_relative_path"
TEMPLATE_MAP=(
  "CLAUDE.md.tmpl|CLAUDE.md"
  ".env.tmpl|.env"
  "package.json.tmpl|package.json"
  "memory/MEMORY.md.tmpl|memory/MEMORY.md"
  "memory/agent-identity.md.tmpl|memory/agent-identity.md"
  "memory/incident-reports.md.tmpl|memory/incident-reports.md"
  "tools/aliases.sh.tmpl|tools/aliases.sh"
  "tools/telegram-server.js.tmpl|tools/telegram-server.js"
  "tools/telegram-send.sh.tmpl|tools/telegram-send.sh"
  "tools/telegram-heartbeat.sh.tmpl|tools/telegram-heartbeat.sh"
  "tools/telegram-inbox.sh.tmpl|tools/telegram-inbox.sh"
  "tools/telegram-poll.sh.tmpl|tools/telegram-poll.sh"
  "tools/mission-summary.sh.tmpl|tools/mission-summary.sh"
  "scripts/telegram-start.sh.tmpl|scripts/telegram-start.sh"
  "scripts/telegram-stop.sh.tmpl|scripts/telegram-stop.sh"
  "scripts/telegram-restart.sh.tmpl|scripts/telegram-restart.sh"
  "scripts/telegram-status.sh.tmpl|scripts/telegram-status.sh"
)

substitute() {
  local content="$1"
  content="${content//"{{AGENT_NAME}}"/$AGENT_NAME}"
  content="${content//"{{AGENT_DISPLAY_NAME}}"/$AGENT_DISPLAY_NAME}"
  content="${content//"{{AGENT_DIR}}"/$AGENT_DIR}"
  content="${content//"{{PROJECT_DIR}}"/$PROJECT_DIR}"
  content="${content//"{{PROJECT_NAME}}"/$PROJECT_NAME}"
  content="${content//"{{PROJECT_DESCRIPTION}}"/$PROJECT_DESCRIPTION}"
  content="${content//"{{TELEGRAM_BOT_TOKEN}}"/$TELEGRAM_BOT_TOKEN}"
  content="${content//"{{TELEGRAM_CHAT_ID}}"/$TELEGRAM_CHAT_ID}"
  content="${content//"{{ANTHROPIC_AUTH_TOKEN}}"/$ANTHROPIC_AUTH_TOKEN}"
  content="${content//"{{ANTHROPIC_BASE_URL}}"/$ANTHROPIC_BASE_URL}"
  content="${content//"{{GITHUB_REPO}}"/$GITHUB_REPO}"
  content="${content//"{{PROD_URL}}"/$PROD_URL}"
  content="${content//"{{AGENT_USERNAME}}"/$AGENT_USERNAME}"
  content="${content//"{{AGENT_ROLE}}"/$AGENT_ROLE}"
  content="${content//"{{CREATED_DATE}}"/$CREATED_DATE}"
  echo "$content"
}

dry_run() {
  echo "── DRY RUN — would generate these files: ──"
  for mapping in "${TEMPLATE_MAP[@]}"; do
    IFS='|' read -r tmpl out <<< "$mapping"
    echo "  $AGENT_DIR/$out  ←  $TEMPLATES_DIR/$tmpl"
  done
  echo ""
  echo "Dry run complete. No files created."
}

generate_agent() {
  if [ "$DRY_RUN" = true ]; then
    dry_run
    exit 0
  fi

  # Create all directories
  for mapping in "${TEMPLATE_MAP[@]}"; do
    IFS='|' read -r tmpl out <<< "$mapping"
    mkdir -p "$(dirname "$AGENT_DIR/$out")"
  done
  mkdir -p "$AGENT_DIR"/{logs,missions/{todo,in-progress,done,failed,results},knowledge,sandbox}

  # Generate each file
  local generated=0
  for mapping in "${TEMPLATE_MAP[@]}"; do
    IFS='|' read -r tmpl out <<< "$mapping"
    local template_file="$TEMPLATES_DIR/$tmpl"
    local output_file="$AGENT_DIR/$out"

    if [ ! -f "$template_file" ]; then
      echo "  WARNING: Template not found: $template_file"
      continue
    fi

    substitute "$(cat "$template_file")" > "$output_file"

    if [[ "$out" == scripts/* ]] || [[ "$out" == tools/*.sh ]]; then
      chmod +x "$output_file"
    fi

    generated=$((generated + 1))
    echo "  ✓ $out"
  done

  # .gitignore
  cat > "$AGENT_DIR/.gitignore" << 'GITIGNORE'
.env
.telegram-last-update
.telegram-server.pid
node_modules/
logs/*.log
logs/*.jsonl
GITIGNORE

  # Empty log files
  touch "$AGENT_DIR/logs/telegram.log"
  touch "$AGENT_DIR/logs/errors.log"
  touch "$AGENT_DIR/logs/messages.jsonl"

  # npm install
  echo ""
  echo "Installing npm dependencies..."
  (cd "$AGENT_DIR" && [ -f "package.json" ] && npm install --silent 2>&1 | tail -1 || true)

  print_summary "$generated"
}

print_summary() {
  local generated="$1"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Agent Generated Successfully"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Name:         $AGENT_DISPLAY_NAME"
  echo "  Directory:    $AGENT_DIR"
  echo "  Project:      $PROJECT_DIR"
  echo "  Telegram:     $AGENT_USERNAME"
  echo "  Files:        $generated generated"
  echo ""
  echo "  Next steps:"
  echo "  1. cd $AGENT_DIR"
  echo "  2. Edit CLAUDE.md — fill in tech stack, key files, warnings"
  echo "  3. Edit .env — verify tokens and URLs"
  echo "  4. Start Telegram server: ./scripts/telegram-start.sh"
  echo "  5. Add aliases to ~/.zshrc: source $AGENT_DIR/tools/aliases.sh"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}
