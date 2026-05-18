# lib/parse-args.sh — Argument parsing for generate-agent.sh
# Sets: CONFIG_FILE, INTERACTIVE, DRY_RUN

CONFIG_FILE=""
INTERACTIVE=false
DRY_RUN=false

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --config)
        CONFIG_FILE="$2"
        shift 2
        ;;
      --interactive|-i)
        INTERACTIVE=true
        shift
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --help|-h)
        echo "Usage: generate-agent.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --config FILE      Path to config file (KEY=VALUE format)"
        echo "  --interactive, -i  Interactive mode — prompts for each value"
        echo "  --dry-run          Show what would be generated without creating files"
        echo "  --help, -h         Show this help"
        echo ""
        echo "Config file format:"
        echo "  AGENT_NAME=my-agent"
        echo "  AGENT_DISPLAY_NAME=MyAgent"
        echo "  AGENT_DIR=/srv/dev/agents/my-agent"
        echo "  PROJECT_DIR=/srv/dev/my-project"
        echo "  ... (run --interactive to see all fields)"
        exit 0
        ;;
      *)
        echo "Unknown option: $1"
        echo "Run with --help for usage."
        exit 1
        ;;
    esac
  done
}
