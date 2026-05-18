#!/usr/bin/env bash
# agent-generator — Generate a new AI agent from templates
# Usage:
#   ./tools/generate-agent.sh --config agent-config.env
#   ./tools/generate-agent.sh --interactive
#
# The config file is a simple KEY=VALUE file with all placeholder values.
# Templates use {{PLACEHOLDER}} syntax and live in templates/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GEN_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATES_DIR="$GEN_DIR/templates"

# ── Source library modules ───────────────────────────────────────────────────
source "$SCRIPT_DIR/lib/parse-args.sh"
source "$SCRIPT_DIR/lib/interactive.sh"
source "$SCRIPT_DIR/lib/config.sh"
source "$SCRIPT_DIR/lib/generate.sh"

# ── Banner ──────────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Agent Generator — AI Agent Factory"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Parse arguments ─────────────────────────────────────────────────────────
parse_args "$@"

# ── Load configuration ──────────────────────────────────────────────────────
if [ "$INTERACTIVE" = true ]; then
  run_interactive
  load_config
elif [ -n "$CONFIG_FILE" ]; then
  load_config
else
  echo "ERROR: Specify --config FILE or --interactive"
  echo "Run with --help for usage."
  exit 1
fi

# ── Validate & derive ───────────────────────────────────────────────────────
validate_config
set_derived

# ── Generate ────────────────────────────────────────────────────────────────
echo ""
echo "Generating agent: $AGENT_DISPLAY_NAME"
echo "  Target: $AGENT_DIR"
echo "  Project: $PROJECT_DIR"
echo ""

generate_agent
