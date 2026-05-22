# Inter-Agent Communication System

## What is it?

The inter-agent system lets AI agents send messages to each other. Each agent has a Telegram bot and a bridge process that monitors a shared mailbox. When Agent A sends a message to Agent B, it lands in Agent B's mailbox inbox as a JSON file. Agent B's bridge picks it up within 5 seconds and spawns Claude to answer.

## Architecture

```
Agent A (Claude)                    Agent B (Claude)
    │                                    │
    ▼                                    ▲
MCP tool: send_message              Bridge polls inbox
    │                                    │
    ▼                                    ▼
Mailbox: /srv/dev/agents/_shared/mailbox/<target>/inbox/<msg>.json
```

## Components

| Component | Location | Role |
|-----------|----------|------|
| MCP server | `_shared/mcp/inter-agent-bridge.js` | MCP tools: `list_agents`, `send_message`, `request_config`, `check_inbox`, `agent_dashboard`, `health_check`, `report_incident` |
| Per-agent bridge | `tools/agent-bridge.js` in each agent | Polls inbox every 5s, processes messages, spawns Claude for questions |
| Registry | `_shared/registry.txt` | `agent-name → @username → directory` |
| Mailboxes | `_shared/mailbox/<agent>/inbox/` | JSON message files |
| Incidents | `_shared/incidents/` | Shared incident reports |
| Shared tools | `_shared/tools/` | Scripts usable by all agents |

## Available MCP Tools

All callable from Claude missions via the `mcp__inter-agent__*` prefix:

| Tool | What it does |
|------|-------------|
| `list_agents` | List all agents with running status (server PID, bridge PID) |
| `agent_dashboard` | Quick dashboard: server + bridge status icons, mailbox counts |
| `health_check` | Comprehensive ecosystem check (full/compact/json/fix modes) |
| `send_message` | Send a message/question to another agent |
| `request_config` | Request deployment config from another agent |
| `check_inbox` | Check incoming messages |
| `report_incident` | Report a communication problem |

## Shell Commands

```bash
# Quick dashboard
bash /srv/dev/agents/_shared/tools/agent-dashboard.sh

# Report an incident
bash /srv/dev/agents/_shared/tools/agent-incident.sh <type> "<detail>"

# Test inter-agent comm
bash /srv/dev/agents/_shared/tools/inter-agent-test.sh

# Wait for agent responses (safe polling — no sleep blocks)
bash /srv/dev/agents/_shared/tools/agent-wait.sh <agent-name> [timeout] [min-responses]
bash /srv/dev/agents/_shared/tools/agent-wait.sh --any [timeout]

# Health check (full ecosystem)
bash /srv/dev/agents/_shared/tools/health-check.sh [--compact|--json|--fix]
```

## Message Flow

1. **Send**: Agent calls `mcp__inter-agent__send_message` with target + message
2. **Deliver**: Message is written as JSON to `_shared/mailbox/<target>/inbox/`
3. **Pickup**: Target agent's bridge (`agent-bridge.js`) polls every 5s, detects new message
4. **Process**: Bridge spawns `claude -p "..."` to answer questions, or auto-responds for config requests
5. **Respond**: Bridge writes response back to sender's inbox
6. **Notify**: Bridge sends Telegram notification to the target agent's chat

## Message Types

| Type | Behavior |
|------|----------|
| `question` | Spawns Claude on the target agent to answer (max 3 turns) |
| `config-request` | Auto-responds with sanitized config (no Claude needed) |
| `response` | Reply to a previous question — delivered directly, no processing |
| `incident` | Routed to the shared incident system |

## Key Design Rules (DO NOT BREAK)

1. **Poll lock**: `polling` flag prevents concurrent `setInterval` overlap
2. **PID guard**: `checkExisting()` prevents multiple bridge instances per agent
3. **One notification per event**: MCP `send_message` does NOT send Telegram notification — the target bridge handles it
4. **Claude env**: Bridge passes `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` to `execSync` for Claude CLI
