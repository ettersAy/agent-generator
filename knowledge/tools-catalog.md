# Tools Catalog

## Shared Tools (`/srv/dev/agents/_shared/tools/`)

All agents can use these. Every tool here is mirrored in agent-generator's `tools/` directory.

### Ecosystem Health

| Tool | Usage | Description |
|------|-------|-------------|
| `health-check.sh` | `bash health-check.sh [--compact\|--json\|--fix]` | Comprehensive ecosystem health: all agents, bridges, dispatcher, orphans, mailboxes |
| `agent-dashboard.sh` | `bash agent-dashboard.sh` | Multi-agent dashboard overview (PID, status, mailbox) |
| `agent-registry.sh` | `bash agent-registry.sh` | List/manage the agent registry |

### Git & Shipping

| Tool | Usage | Description |
|------|-------|-------------|
| `git-ship.sh` | `bash git-ship.sh "message" [files...]` | Stage, commit, push in one command. Shows context first. `--dry-run` to preview. |

### Inter-Agent Communication

| Tool | Usage | Description |
|------|-------|-------------|
| `inter-agent-test.sh` | `bash inter-agent-test.sh` | Test inter-agent communication end-to-end |
| `agent-wait.sh` | `bash agent-wait.sh <agent> [timeout] [min]` | Wait for inter-agent responses with safe 2s polling — no sleep blocks |
| `agent-incident.sh` | `bash agent-incident.sh <type> "<detail>"` | Report communication incidents to shared incident system |

### Agent Management

| Tool | Usage | Description |
|------|-------|-------------|
| `open-dashboard.sh` | `bash open-dashboard.sh [--wiki\|--logs]` | Start (if needed) and open web dashboard in browser |
| `propagate-to-agents.sh` | `bash propagate-to-agents.sh --block-file <f> --anchor <s> --before <p>` | Apply a block of text to all agent CLAUDE.md files idempotently. `--dry-run`, `--test` |
| `shared-aliases.sh` | `source shared-aliases.sh` | Shared shell aliases for all agents |

---

## Agent-Generator Local Tools (`tools/`)

These are only relevant to agent-generator's own operations. Not shared.

### Agent Generation

| Tool | Usage | Description |
|------|-------|-------------|
| `generate-agent.sh` | `bash generate-agent.sh --config <file>` | Generate a new AI agent from templates |
| `mission-runner.sh` | Called by dispatcher | Execute a single mission via Claude CLI |
| `mission-summary.sh` | `bash mission-summary.sh [-n N\|-a]` | Summarize recent missions |

### Telegram Server

| Tool | Usage | Description |
|------|-------|-------------|
| `unified-server.js` | Started by `telegram-start.sh` | Main server handling all agents' Telegram bots |
| `telegram-server.js` | Per-agent fallback | Legacy per-agent Telegram bot server |
| `telegram-send.sh` | `bash telegram-send.sh "message"` | Send Telegram message |
| `telegram-inbox.sh` | `bash telegram-inbox.sh` | View Telegram message inbox |
| `telegram-heartbeat.sh` | `bash telegram-heartbeat.sh` | Check Telegram connectivity |
| `telegram-poll.sh` | `bash telegram-poll.sh` | Manual poll for Telegram updates |
| `agent-bridge.js` | Managed by unified-server | Per-agent inter-agent message bridge |

### Communication

| Tool | Usage | Description |
|------|-------|-------------|
| `agent-ask.sh` | `bash agent-ask.sh <agent> "question"` | Quick question to another agent |
| `agent-respond.sh` | `bash agent-respond.sh <msg-file>` | Manually respond to an inter-agent message |
| `agent-status-all.sh` | `bash agent-status-all.sh` | Status check for all agents |

### Shell Helpers

| Tool | Usage | Description |
|------|-------|-------------|
| `aliases.sh` | `source aliases.sh` | Shell aliases for agent-generator operations |

---

## MCP Tools (via `mcp__inter-agent__*`)

Callable directly from Claude missions:

| Tool | Description |
|------|-------------|
| `list_agents` | List all agents with running status |
| `agent_dashboard` | Quick health dashboard |
| `health_check` | Comprehensive health check (full/compact/json/fix) |
| `send_message` | Send message to another agent |
| `request_config` | Request deployment config from another agent |
| `check_inbox` | Check incoming inter-agent messages |
| `report_incident` | Report a communication incident |

---

## Automation Discipline

See `CLAUDE.md` — Automation Discipline section for:
- Hard Enforcement Rule (use tools immediately after building)
- Post-Task Reflection Rule (identify repeat work, automate it)
- Tool Sharing Rule (shared vs local, propagate after creating)
- Bash Safety (no long sleeps, use Monitor or agent-wait.sh)
