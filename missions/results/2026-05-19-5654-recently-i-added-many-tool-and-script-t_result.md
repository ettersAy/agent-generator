# Mission Result — "recently i added many tool and script to you..."

## Result

Yes, I am aware of all the recently added tools and features. Here is the comprehensive listing, organized by where each lives and who it serves.

---

## A. Agent Generator's Own Tools & Features

### Core Scripts (`scripts/`)
| Script | Purpose |
|--------|---------|
| `telegram-start.sh` | Start Node.js server + mission dispatcher |
| `telegram-stop.sh` | Graceful stop of server + dispatcher (does NOT kill running Claude) |
| `telegram-restart.sh` | Restart wrapper |
| `telegram-status.sh` | Health check: server, dispatcher, all agents, queue |
| `mission-dispatcher.sh` | Background daemon: watches `missions/todo/`, spawns `mission-runner.sh` |
| `web-dashboard-start.sh` | Start web dashboard on port 3099 |
| `web-dashboard-stop.sh` | Stop web dashboard |

### Tools (`tools/`)
| Tool | Purpose |
|------|---------|
| `generate-agent.sh` | THE GENERATOR — creates new AI agents from templates |
| `telegram-server.js` | Main Node.js server: Telegram polling, message routing, AI responses, **now auto-starts the inter-agent bridge on boot** |
| `mission-runner.sh` | Spawns Claude CLI for long missions, captures output to disk |
| `mission-summary.sh` | Recall what I was working on (supports `-n N`, `-a`) |
| `agent-ask.sh` | **NEW** — Send messages/questions to other AI agents via shared mailbox |
| `agent-bridge.js` | **NEW** — Background daemon: polls inbox, auto-responds to config requests, spawns Claude for questions |
| `agent-respond.sh` | **NEW** — Send response messages back to other agents |
| `web-dashboard.js` | Enhanced web dashboard + wiki + REST API (port 3099) |
| `telegram-send.sh` | Send Telegram messages from shell |
| `telegram-inbox.sh` | View/manage Telegram messages |
| `telegram-poll.sh` | Manual poll |
| `telegram-heartbeat.sh` | Update alive indicator |
| `aliases.sh` | Shell shortcuts: `tg-start`, `tg-stop`, `dispatch-start`, `mq`, etc. |

### Library Modules (`tools/lib/`)
| Module | Purpose |
|--------|---------|
| `agents.js` | Agent discovery & status (used by server + dashboard) |
| `queue.js` | Mission queue snapshot, dispatcher status, log tail |
| `generation.js` | Agent generation logic |
| `logging.sh` / `config.sh` / `env.sh` / `interactive.sh` / `missions.sh` / `parse-args.sh` / `process.sh` / `generate.sh` | Generator sub-modules |

### Shell Aliases (via `aliases.sh` + `shared-aliases.sh`)
```
tg-start / tg-stop / tg-restart / tg-status
tg-log / tg-inbox / tg-errors / tg-update
dispatch-start / dispatch-stop / dispatch-log
mission-summary / mq
agent-ask / agent-dashboard / agent-list / agent-lookup / agent-test / agent-inbox-all
```

### MCP Configuration (`.mcp.json`)
5 MCP tools exposed to Claude missions:
- `list_agents` — List all registered agents with running status
- `send_message` — Send a message/question to another agent
- `request_config` — Request deployment config from another agent (auto-responded)
- `check_inbox` — Check inter-agent mailbox for incoming messages
- `agent_dashboard` — Full multi-agent health overview

---

## B. Shared Infrastructure (for ALL agents)

### `/srv/dev/agents/_shared/registry.txt`
Agent registry mapping `agent-name → @TelegramUsername → path`.
Currently registered: `tamarine-bot`, `mouss-ai`, `agent-generator`.

### `/srv/dev/agents/_shared/mailbox/`
File-based mailbox system with per-agent inbox directories. Messages are JSON files with id, from, to, timestamp, type, subject, body, reply_to.

### `/srv/dev/agents/_shared/mcp/inter-agent-bridge.js`
MCP server (JSON-RPC 2.0 over stdio) exposing 5 inter-agent tools directly to Claude. Configured per-agent via `.mcp.json`.

### `/srv/dev/agents/_shared/tools/`
| Tool | Purpose |
|------|---------|
| `agent-dashboard.sh` | Multi-agent health overview (text or `--json`) showing server/bridge PIDs, uptime, queue counts, disk usage, pending messages |
| `agent-registry.sh` | CLI: `list`, `lookup`, `bot`, `dir`, `add` |
| `inter-agent-test.sh` | End-to-end test of agent-to-agent messaging |
| `shared-aliases.sh` | Cross-agent shortcuts sourceable by all agents |

---

## C. Templates (what other agents get when generated)

Each generated agent gets these from `templates/`:
- `CLAUDE.md.tmpl` — Parameterized agent identity
- `.env.tmpl` — API keys and config
- `.mcp.json.tmpl` — **NEW** — MCP inter-agent bridge config
- `package.json.tmpl` — Minimal Node.js package
- `tools/` — `telegram-server.js.tmpl`, `telegram-send.sh.tmpl`, `telegram-inbox.sh.tmpl`, `telegram-poll.sh.tmpl`, `telegram-heartbeat.sh.tmpl`, `aliases.sh.tmpl`, `mission-summary.sh.tmpl`
- `scripts/` — `telegram-start.sh.tmpl`, `telegram-stop.sh.tmpl`, `telegram-status.sh.tmpl`, `telegram-restart.sh.tmpl`
- `memory/` — `MEMORY.md.tmpl`, `agent-identity.md.tmpl`, `incident-reports.md.tmpl`

---

## D. Web Dashboard & Wiki

- **Dashboard** (`tools/web-dashboard.js`, port 3099): Agent list, mission queue, log viewer, service controls
- **Wiki** (`docs/`): 12 documentation pages covering architecture, code structure, how-to-start, main features, QA, Telegram system (overview/detailed/explained/optimization), tools and MCP, what-is-agent-generator, workflows
- **API endpoints**: `/api/agents`, `/api/queue`, `/api/missions/:id`, `/api/status`, `/api/logs/:source`, `/api/services/:name/:action`

---

## E. Mission Execution System (v2)

Queue-based architecture with process isolation:
- Missions created via Telegram → saved to `missions/todo/`
- Dispatcher daemon picks up → moves to `in-progress/` → spawns `mission-runner.sh`
- Runner executes Claude with output written directly to disk (zero memory accumulation)
- Concurrency control (max 2 Claude processes)
- Crash recovery on restart (recovers orphaned in-progress missions)

---

## Summary: What's NEW (not yet committed)

The following are the recently added, uncommitted features:

1. **Inter-Agent Communication System** — `agent-ask.sh`, `agent-bridge.js`, `agent-respond.sh`
2. **Shared Mailbox** — `/srv/dev/agents/_shared/mailbox/{agent}/inbox/`
3. **Agent Registry** — `/srv/dev/agents/_shared/registry.txt` + `agent-registry.sh`
4. **Inter-Agent MCP Server** — 5 MCP tools callable from Claude missions
5. **Agent Dashboard** — `agent-dashboard.sh` (multi-agent health overview)
6. **Inter-Agent Test Harness** — `inter-agent-test.sh`
7. **MCP Config Template** — `.mcp.json.tmpl` so generated agents get MCP tools
8. **Bridge Auto-Start** — `telegram-server.js` modified to spawn the bridge on boot
9. **Shared Aliases** — `shared-aliases.sh` for cross-agent shortcuts

These form a complete **inter-agent communication fabric** allowing AI agents to discover each other, send questions, request configs, and coordinate work — all via the filesystem with Telegram notifications.
