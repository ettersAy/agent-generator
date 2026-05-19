# Full Code Structure

```
/srv/dev/agents/agent-generator/
│
├── CLAUDE.md                          # Agent identity and operating instructions
├── .env                               # Telegram token, API keys (gitignored)
├── .gitignore                         # Excludes .env, logs, PID files
├── package.json                       # @anthropic-ai/sdk dependency
│
├── templates/                         # Agent templates with {{PLACEHOLDER}} variables
│   ├── CLAUDE.md.tmpl                 # Agent identity template
│   ├── .env.tmpl                      # Environment config template
│   ├── package.json.tmpl              # Package manifest template
│   ├── memory/                        # Memory file templates
│   ├── scripts/                       # Shell script templates
│   └── tools/                         # Tool templates (server, send, inbox)
│
├── tools/                             # Core executables
│   ├── generate-agent.sh              # Agent generation engine
│   ├── unified-server.js              # Telegram bot server (polling)
│   ├── mission-runner.sh              # Single-mission Claude executor
│   ├── mission-summary.sh             # Summarize recent missions
│   ├── web-dashboard.js               # Web UI + wiki server
│   ├── telegram-server.js             # Legacy server (being replaced)
│   ├── telegram-send.sh               # Send Telegram messages via API
│   ├── telegram-inbox.sh              # View pending messages
│   ├── telegram-poll.sh               # Manual polling debug tool
│   ├── telegram-heartbeat.sh          # Heartbeat monitor
│   ├── aliases.sh                     # Shell aliases
│   │
│   └── lib/                           # Shared libraries (SOLID)
│       ├── env.sh                     # Environment + path config
│       ├── logging.sh                 # Structured logging + notifications
│       ├── process.sh                 # PID management + alive checks
│       ├── missions.sh                # Mission file operations
│       ├── agents.js                  # Agent discovery + status
│       ├── queue.js                   # Mission queue snapshot + ops
│       ├── generation.js              # Agent generation state machine
│       ├── config.sh                  # Config file parsing
│       ├── interactive.sh             # Interactive prompt helpers
│       ├── generate.sh                # Template engine
│       └── parse-args.sh              # Argument parser
│
├── scripts/                           # Management scripts
│   ├── telegram-start.sh              # Start server + dispatcher
│   ├── telegram-stop.sh               # Stop server + dispatcher
│   ├── telegram-restart.sh            # Restart services
│   ├── telegram-status.sh             # Full health check
│   ├── mission-dispatcher.sh          # Background daemon
│   ├── web-dashboard-start.sh         # Start web dashboard
│   └── web-dashboard-stop.sh          # Stop web dashboard
│
├── docs/                              # Documentation (served by wiki)
│   ├── what-is-agent-generator.md     # Identity and purpose
│   ├── how-to-start.md                # Installation and setup guide
│   ├── main-features.md               # Feature catalog
│   ├── code-structure.md              # This file — full file tree
│   ├── architecture.md                # Deep architecture dive
│   ├── workflows.md                   # Important workflows
│   ├── tools-and-mcp.md               # Tools, scripts, MCP servers
│   ├── telegram-system-overview.md    # Telegram integration overview
│   ├── telegram-system-detailed.md    # Telegram internals
│   ├── telegram-system-explained.md   # Walkthrough explanation
│   └── QA.md                          # Q&A / troubleshooting
│
├── memory/                            # Persistent agent memory
│   ├── MEMORY.md                      # Memory index
│   ├── generated-agents.md            # Registry of created agents
│   └── ...                            # Other memory files
│
├── missions/                          # Mission lifecycle
│   ├── todo/                          # Awaiting dispatch
│   ├── in-progress/                   # Currently executing (+ .pid files)
│   ├── done/                          # Completed successfully
│   ├── failed/                        # Failed or timed out
│   └── results/                       # Raw Claude output (*_result.md)
│
├── logs/                              # Operational logs
│   ├── unified-server.log             # Telegram server activity
│   ├── dispatcher.log                 # Mission dispatcher activity
│   ├── web-dashboard.log              # Web server activity
│   └── errors.log                     # Error log
│
└── sandbox/                           # Safe workspace for experiments
```

## File Purposes (Key Files)

### CLAUDE.md
The brain of Agent Generator. Contains the full operating context: identity, architecture, mission execution system, generation workflow, and management commands. Every Claude session starts by reading this file.

### tools/unified-server.js
Node.js Telegram bot. Polls for messages, handles commands (`/start`, `/generate`, `/mission`, `/queue`, `/cancel`), routes free-text to Claude for quick answers, and manages interactive agent generation sessions.

### tools/mission-runner.sh
Receives a mission file path, builds a Claude prompt with mission context, executes `claude -p` with output redirected to disk, then sends a Telegram notification with the result summary. Runs as a `nohup` child of the dispatcher.

### scripts/mission-dispatcher.sh
Background daemon that polls `missions/todo/` every 5 seconds. Claims missions, moves them to `in-progress/`, spawns `mission-runner.sh` via `nohup`, enforces concurrency limits, and recovers orphaned missions on startup.

### tools/generate-agent.sh
Reads templates from `templates/`, substitutes `{{PLACEHOLDER}}` variables from a config file, and writes a complete agent to a target directory.

### tools/web-dashboard.js
Zero-dependency HTTP server. Renders dashboard HTML, serves the wiki, and provides JSON API endpoints for agents, queue, logs, and system status.
