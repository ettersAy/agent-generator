# How to Start and Use Agent Generator

## Prerequisites

- **Node.js** 18+ (for the Telegram server and web dashboard)
- **Bash** (for all shell scripts)
- **Claude CLI** installed and in PATH (`claude`)
- **Telegram Bot Token** from [BotFather](https://t.me/BotFather)
- **Anthropic/DeepSeek API key** for AI inference

## Installation

```bash
cd /srv/dev/agents/agent-generator
npm install        # Installs @anthropic-ai/sdk
```

## Configuration

The `.env` file must contain:

```bash
TELEGRAM_BOT_TOKEN=123:abc
TELEGRAM_CHAT_ID=123456789
ANTHROPIC_AUTH_TOKEN=sk-xxx
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
```

## Starting Services

### Start Everything (Telegram bot + dispatcher)

```bash
tg-start
# or:
bash scripts/telegram-start.sh
```

This starts:
1. `unified-server.js` — Telegram polling bot (Node.js)
2. `mission-dispatcher.sh` — Background daemon watching for missions

### Start Web Dashboard

```bash
bash scripts/web-dashboard-start.sh
# Dashboard: http://localhost:3099
# Wiki:      http://localhost:3099/wiki
```

### Check Status

```bash
tg-status           # Full health check for all services
mq                  # Quick mission queue overview
```

### Stop Services

```bash
tg-stop             # Stops server + dispatcher (Claude processes survive)
```

## Using Via Telegram

| Command | Action |
|---------|--------|
| `/start` | Welcome message and command list |
| `/generate --interactive` | Start interactive agent generation wizard |
| `/generate --config <url>` | Generate agent from config file URL |
| `/list` | List all generated agents |
| `/status <name>` | Check specific agent status |
| `/mission <task>` | Queue a mission for AI execution |
| `/queue` | View current mission queue |
| `/cancel <id>` | Cancel a pending mission |
| Any text | Quick AI answer from Claude |

## Using Via Web Dashboard

| URL | Purpose |
|-----|---------|
| `http://localhost:3099/` | Main dashboard |
| `http://localhost:3099/wiki` | Documentation wiki |
| `http://localhost:3099/api/status` | Full system status (JSON) |

## Generating Your First Agent

1. Send `/generate --interactive` via Telegram
2. Answer the prompts (agent name, project directory, etc.)
3. The generator creates a complete agent at `/srv/dev/agents/<name>/`
4. Start the agent: `cd /srv/dev/agents/<name> && tg-start`
5. The agent is now live on Telegram

## Shell Aliases

Located in `tools/aliases.sh`. Source them in your `.zshrc`:

```bash
source /srv/dev/agents/agent-generator/tools/aliases.sh
```

Available aliases:
- `tg-start`, `tg-stop`, `tg-restart`, `tg-status`
- `tg-log`, `tg-inbox`, `tg-errors`
- `dispatch-start`, `dispatch-stop`, `dispatch-log`
- `mq` (mission queue overview)
- `mission-summary`
- `web-start`, `web-stop`
