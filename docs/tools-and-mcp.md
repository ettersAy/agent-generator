# Tools, Scripts, and MCP Servers

## Shell Scripts

### Core Management

| Script | Purpose |
|--------|---------|
| `scripts/telegram-start.sh` | Start unified server + dispatcher in background |
| `scripts/telegram-stop.sh` | Stop server + dispatcher (Claude processes survive) |
| `scripts/telegram-restart.sh` | Stop then start |
| `scripts/telegram-status.sh` | Full health check for all components |
| `scripts/web-dashboard-start.sh` | Start web dashboard on port 3099 |
| `scripts/web-dashboard-stop.sh` | Stop web dashboard |

### Mission Management

| Script | Purpose |
|--------|---------|
| `scripts/mission-dispatcher.sh` | Background daemon — watches todo/, spawns runners, recovers orphans |
| `tools/mission-runner.sh` | Single mission executor — spawns Claude, captures output, sends notification |
| `tools/mission-summary.sh` | Summarize recent completed missions |

### Telegram

| Script | Purpose |
|--------|---------|
| `tools/telegram-send.sh` | Send messages via Telegram Bot API |
| `tools/telegram-inbox.sh` | View and manage message inbox |
| `tools/telegram-poll.sh` | Manual polling for debugging |
| `tools/telegram-heartbeat.sh` | Monitor bot health |

### Agent Generation

| Script | Purpose |
|--------|---------|
| `tools/generate-agent.sh` | Template-based agent generator |

### Shared Libraries

| Library | Language | Purpose |
|---------|----------|---------|
| `tools/lib/env.sh` | Bash | Environment loading, directory paths |
| `tools/lib/logging.sh` | Bash | Structured logging, Telegram notifications, HTML escaping |
| `tools/lib/process.sh` | Bash | PID file operations, process alive checks, runner counting |
| `tools/lib/missions.sh` | Bash | Mission file CRUD, result file path computation |
| `tools/lib/config.sh` | Bash | Config file parsing for agent generation |
| `tools/lib/interactive.sh` | Bash | Interactive prompts for generation wizard |
| `tools/lib/generate.sh` | Bash | Template engine (placeholder substitution) |
| `tools/lib/parse-args.sh` | Bash | CLI argument parser |
| `tools/lib/agents.js` | Node.js | Agent discovery, status, detail |
| `tools/lib/queue.js` | Node.js | Mission queue snapshot, dispatcher status, log tails |
| `tools/lib/generation.js` | Node.js | Agent generation session state machine |

## Node.js Tools

| Tool | Purpose |
|------|---------|
| `tools/unified-server.js` | Main Telegram bot server — polling, command routing, quick AI, generation sessions |
| `tools/web-dashboard.js` | HTTP server — dashboard, wiki, JSON APIs |
| `tools/telegram-server.js` | Legacy Telegram server (being phased out) |

## MCP Servers Used

Agent Generator leverages the **Vercel MCP plugin** (`plugin:vercel:vercel`) which provides:

| MCP Tool | Purpose |
|----------|---------|
| `mcp__plugin_vercel_vercel__authenticate` | Start OAuth flow for Vercel API access |
| `mcp__plugin_vercel_vercel__complete_authentication` | Complete OAuth callback |
| `vercel:deploy` | Deploy projects to Vercel (preview or production) |
| `vercel:env` | Manage Vercel environment variables |
| `vercel:status` | Show project status and recent deployments |
| `vercel:ai-sdk` | AI SDK integration guidance |
| `vercel:nextjs` | Next.js App Router guidance |
| `vercel:vercel-cli` | Vercel CLI operations |
| `vercel:vercel-functions` | Serverless/Edge Functions guidance |
| `vercel:vercel-storage` | Blob, Edge Config, Postgres, Redis |
| `vercel:marketplace` | Marketplace integration discovery |
| `vercel:auth` | Clerk/Descope/Auth0 integration |

These MCP tools are available to any Claude session running in this repository and are used when the agent needs to interact with Vercel services.

## Claude Code Built-in Tools

The agent uses the full Claude Code tool suite:

| Tool Category | Key Tools |
|---------------|-----------|
| **File Operations** | Read, Write, Edit, Glob, Grep |
| **Execution** | Bash (shell commands with sandboxing) |
| **Task Management** | TaskCreate, TaskUpdate, TaskList, TaskGet |
| **Web** | WebFetch, WebSearch |
| **Code Review** | review (PR review), security-review |
| **Planning** | EnterPlanMode, ExitPlanMode |
| **GitHub** | gh CLI integration (issues, PRs, commits) |
| **Notifications** | PushNotification, Monitor, CronCreate |

## Shell Aliases

Source `tools/aliases.sh` for convenience:

```bash
source /srv/dev/agents/agent-generator/tools/aliases.sh
```

| Alias | Expands To |
|-------|-----------|
| `tg-start` | `bash scripts/telegram-start.sh` |
| `tg-stop` | `bash scripts/telegram-stop.sh` |
| `tg-restart` | `bash scripts/telegram-restart.sh` |
| `tg-status` | `bash scripts/telegram-status.sh` |
| `tg-log` | `tail -f logs/unified-server.log` |
| `tg-inbox` | `bash tools/telegram-inbox.sh` |
| `tg-errors` | `tail -f logs/errors.log` |
| `dispatch-start` | Start dispatcher independently |
| `dispatch-stop` | Stop dispatcher independently |
| `dispatch-log` | `tail -f logs/dispatcher.log` |
| `mq` | Quick mission queue overview |
| `mission-summary` | `bash tools/mission-summary.sh` |
| `web-start` | `bash scripts/web-dashboard-start.sh` |
| `web-stop` | `bash scripts/web-dashboard-stop.sh` |

## Quick Reference: Common Operations

```bash
# Full system start
tg-start && web-start

# Check everything
tg-status

# View mission queue
mq

# See what I was last working on
mission-summary

# View live logs
tg-log        # Telegram server
dispatch-log  # Mission dispatcher

# Stop (Claude keeps running)
tg-stop && web-stop
```
