# Telegram Messaging System — Short Overview

**Architecture:** Each AI agent is powered by a central shared Node.js library at `/srv/dev/agents/telegram-agent-kit/`. Every generated agent instantiates this kit as a thin wrapper.

## How It Works

### 1. Polling Server
Each agent runs its own background `node` process (launched via `scripts/telegram-start.sh`). It performs **long-polling** against the Telegram Bot API — no webhooks required.

```
while (this.running) { await this.poll(); }
```

Each poll calls `GET https://api.telegram.org/bot<TOKEN>/getUpdates?offset=<last_id>&timeout=30`. The server tracks the last-seen update ID in `.telegram-last-update` to never re-process old messages.

### 2. Message Routing
- **`/start`** → Welcome message with available commands
- **`/mission <task>`** → Spawns a **Claude CLI** child process for long-running work
- **`/externalllm <query>`** → Fast **DeepSeek API** call
- **Any other text** → Quick AI answer (DeepSeek API, Claude CLI fallback)

### 3. Mission Lifecycle
When `/mission` is invoked:
1. A mission ticket file is created in `missions/in-progress/`
2. A `claude` child process is spawned
3. A Telegram message is sent and **edited live every 60 seconds** as a progress heartbeat
4. On completion, the result is sent and the mission moves to `missions/done/`

### 4. Persistence & Recovery
- Messages logged to `logs/messages.jsonl` with `replied` flag
- On server restart, any in-progress missions are recovered by checking surviving PIDs
- Each agent has its own `.env` with bot token + chat ID — fully isolated

### 5. Companion Shell Scripts
- `telegram-send.sh` — fire-and-forget messages via `curl`
- `telegram-poll.sh --watch` — manual polling for debugging
- `telegram-inbox.sh` — browse/unread management
- `telegram-heartbeat.sh` — send status updates
- `mission-summary.sh` — review recent missions

**Key design point:** Each agent has its own Telegram bot token (from BotFather), so you chat directly with each bot individually. No shared state between agents.
