# Telegram Messaging System — Full Technical Documentation

> **Generated:** 2026-05-16 | **Version:** 1.0.0
> Covers the complete message flow from Telegram API → polling loop → dispatch → mission execution → result delivery.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Telegram Bot API                             │
│                    api.telegram.org/bot<TOKEN>                      │
└──────┬──────────────────────┬──────────────────────┬────────────────┘
       │ Bot Token A          │ Bot Token B          │ Bot Token C
       ▼                      ▼                      ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Agent A      │    │ Agent B      │    │ Agent C      │
│ telegram-    │    │ telegram-    │    │ telegram-    │
│ server.js    │    │ server.js    │    │ server.js    │
│              │    │              │    │              │
│ .env         │    │ .env         │    │ .env         │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │ require()
                           ▼
               ┌───────────────────────┐
               │ telegram-agent-kit    │
               │ /srv/dev/agents/      │
               │ telegram-agent-kit/   │
               │                       │
               │ • AgentServer         │
               │ • TelegramClient      │
               │ • ClaudeWorker        │
               │ • MissionManager      │
               │ • MessageStore        │
               │ • AiBackends          │
               └───────────────────────┘
```

**Key principle:** One bot token per agent, one Node.js process per agent, shared library code. Zero shared runtime state.

---

## 2. Core Library: `telegram-agent-kit`

### 2.1 `config.js` — Configuration Loader

Parses the agent's `.env` file and derives all paths and configuration.

**Loaded values from `.env`:**
| Env variable | Config key | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `TG_TOKEN` | Authenticates all Bot API calls |
| `TELEGRAM_CHAT_ID` | `CHAT_ID` | Default chat for outbound messages |
| `ANTHROPIC_AUTH_TOKEN` | `DS_API_KEY` | DeepSeek/Anthropic API key |
| `ANTHROPIC_BASE_URL` | `DS_BASE` | API base URL, normalized on load |
| `CLAUDE_MAX_BUDGET` | `CLAUDE_BUDGET` | Max USD budget for CLI missions |

**Derived paths (all within AGENT_DIR):**

```
AGENT_DIR/
├── .telegram-last-update   ← Offset tracker for getUpdates
├── .telegram-server.pid    ← PID file for process management
├── logs/
│   ├── telegram.log        ← Server stdout/stderr
│   ├── messages.jsonl      ← Incoming message store
│   └── errors.log          ← Structured error log
└── missions/
    ├── todo/
    ├── in-progress/
    ├── done/
    ├── failed/
    └── results/
```

**`makeConfig(agentDir)`** is the single entry point. Every path is deterministic.

---

### 2.2 `telegram-client.js` — Bot API HTTP Client

Wraps the Telegram Bot API in pure Node.js `https` (zero dependencies).

#### Methods

**`getUpdates(offset, timeout=30)`**
```
GET /bot<TOKEN>/getUpdates?offset=<offset>&timeout=<timeout>&allowed_updates=["message"]
```
Returns `{ ok, result: [...] }` where each result contains:
- `update_id` — monotonically increasing integer
- `message.chat.id` — sender's chat ID
- `message.from.first_name` / `message.from.username`
- `message.text` — the message body (empty for non-text)

**`sendMessage(chatId, text, opts={})`**
```
POST /bot<TOKEN>/sendMessage
Body: { chat_id, text, parse_mode: "HTML" }
```
- Automatically truncates text at 3,900 chars (Telegram's limit is 4,096)
- Returns `{ status, body }` with `body.result.message_id`

**`editMessage(chatId, messageId, text)`**
```
POST /bot<TOKEN>/editMessageText
Body: { chat_id, message_id, text }
```
- Used for live progress updates (heartbeat editing)
- Same 3,900 char truncation
- If editing fails (stale message_id), the caller creates a fresh message

**`getMe()`**
```
GET /bot<TOKEN>/getMe
```
- Called once at startup to verify the bot token is valid
- Extracts the bot's `@username` for startup logging

**HTTP implementation:** Uses raw `https.request` / `https.get`. No retry logic, no exponential backoff. Errors bubble up to the poll loop's try/catch.

---

### 2.3 `message-store.js` — Inbox Persistence

Stores every incoming message as a JSON line in `logs/messages.jsonl`.

#### Record format
```json
{
  "update_id": 123456789,
  "from": "Ayoub",
  "username": "ettersAy",
  "chat_id": 987654321,
  "text": "/mission fix the bug",
  "timestamp": "2026-05-16T12:34:56.000Z",
  "replied": false
}
```

#### Key methods

- **`loadLastUpdate()`** — reads `.telegram-last-update`, returns `0` if absent
- **`saveLastUpdate(id)`** — writes the highest-seen `update_id`
- **`storeMsg(data)`** — appends a JSON line to `messages.jsonl`
- **`markReplied(updateId)`** — rewrites the entire JSONL file with `replied: true` for the matching update
- **`getAllMessages()`** — parses and returns all messages (for the `telegram-inbox.sh` shell tool)

**Performance note:** `markReplied` performs full-file rewrite (read all lines → modify one → write all lines). This is acceptable for single-user bot volumes (tens of messages per day) but would degrade at high scale.

**State file:** `.telegram-last-update` is a plain integer. On every poll cycle, after processing all updates, the highest `update_id` is persisted. This guarantees at-least-once delivery (duplicate processing is possible if the process crashes between processing and saving).

---

### 2.4 `mission-manager.js` — Mission Ticket CRUD

Manages the full lifecycle of a `/mission` task.

#### File naming convention
```
{date}-{seq}-{slug}.md

Example: 2026-05-16-1234-fix-login-bug.md
         └── date ──┘└seq┘└── slug ──────┘
```
- `date` — ISO date portion of `new Date()`
- `seq` — last 4 digits of `Date.now()` (collision-resistant enough for single-user)
- `slug` — first 40 chars of user message, alphanumeric + hyphens only, lowercased

#### Mission file template
```markdown
# Mission: <first 80 chars of user message>

| Field | Detail |
|-------|--------|
| **Created** | 2026-05-16T12:34:56.000Z |
| **Status** | todo |
| **Source** | Telegram |
| **PID** | - |

## Original Request

<full user message>

## Progress Log

| Timestamp | Event | Detail |
|-----------|-------|--------|
```

#### Lifecycle transitions

```
todo/ ──→ in-progress/ ──→ done/
                         └──→ failed/
```

- **`create(userMsg)`** → writes to `missions/todo/`
- **`move(fp, destDir)`** → `fs.renameSync` to move between dirs
- **`appendLog(fp, event, detail)`** → appends a row to the Progress Log table by inserting after the table header
- **`updateMeta(fp, updates)`** → regex-replaces `Status` and `PID` rows in the metadata table
- **`getInProgress()`** → lists `missions/in-progress/*.md` for recovery on restart
- **`getResultPath(missionFile)`** → derives `missions/results/<filename>_result.md`
- **`getResultContent(missionFile)`** → reads the result file (written by Claude stdout capture)

**No database — plain filesystem.** The mission file IS the state. This makes recovery trivial: just list files and check PIDs.

---

### 2.5 `claude-worker.js` — Claude CLI Spawn + Heartbeat

The core of long-running mission execution.

#### `spawn(userMessage, missionFile, chatId, cwd)`

Spawns a child process:
```bash
claude -p "<userMessage>" \
  --output-format text \
  --dangerously-skip-permissions \
  --no-session-persistence
```

**Important: `--dangerously-skip-permissions`** means Claude CLI runs with no permission prompts — it autonomously edits files, runs commands, etc. This is the "agent mode" that makes `/mission` powerful.

**stdout capture:** All output is collected in memory and written to `missions/results/<file>_result.md` on process close.

**stderr capture:** Appended to the result file under a `--- stderr ---` section if non-empty.

**Returns:** the child process PID.

#### `startMonitor(missionFile, chatId, pid)`

Runs a **60-second interval heartbeat** after spawn:

1. Sends an initial "Mission in progress" message to Telegram
2. Every 60 seconds, checks `process.kill(pid, 0)` to verify the process is alive
3. Edits the original Telegram message with updated elapsed time and heartbeat count
4. The message cycles through 3 variants:
   - `heartbeatCount % 3 === 0` → "Claude is reasoning deeply."
   - `heartbeatCount % 3 === 1` → "Still running — process alive."
   - `heartbeatCount % 3 === 2` → "Continuing execution."
5. If `editMessage` fails (message was deleted), creates a fresh message
6. When the process exits:
   - **Success path:** reads the result file, sends "Mission complete" with the result text, moves mission to `done/`
   - **Failure path:** sends "Mission process exited with no result", moves mission to `failed/`

**No timeout enforcement.** The monitor runs until the process exits naturally. This is intentional — Claude CLI handles its own budget limits via `--max-budget-usd`.

**Maximum message length:** Results over 3,800 chars are truncated in the Telegram notification (the full result is always available in the result file on disk).

#### `recoverMonitors(chatId)`

Called at server startup. Reads all `missions/in-progress/*.md` files, extracts the PID from each, checks `process.kill(pid, 0)`:
- If the PID is alive → resumes monitoring (reattaches heartbeat)
- If the PID is dead → moves the mission to `failed/`

This means: **server restart does not lose mission state.**

---

### 2.6 `ai-backends.js` — AI API Clients

Three backend tiers, used in cascade:

#### Tier 1: `callDeepSeek(prompt, options)` — Direct HTTPS (fast path)
- Raw `https.request` to DeepSeek's Anthropic-compatible endpoint
- 30s timeout, 1024 max tokens
- Used for: quick replies to non-command text, `/externalllm`
- No SDK dependency — pure Node.js

#### Tier 2: `callDeepSeekSDK(prompt, options)` — Anthropic SDK (rich path)
- Lazily loads `@anthropic-ai/sdk`
- 60s timeout, 4096 max tokens, custom system prompt
- Used for: richer responses when the user explicitly wants a detailed AI answer
- Falls through if SDK is not installed

#### Tier 3: `spawnClaudeSync(prompt, budget, timeoutMs, cwd)` — CLI (fallback)
- Synchronous Claude CLI spawn
- Used when both API backends fail
- Budget-controlled via `--max-budget-usd`
- Timeout via Node's `child_process` timeout option

---

### 2.7 `index.js` — AgentServer (Main Orchestrator)

#### Constructor

```js
new AgentServer(agentDir, {
  agentDisplayName: "MyBot",
  projectName: "MyProject",
  roleDescription: "AI dev agent for MyProject",
  customCommands: { /* pattern → handler */ },
  onMessage: null  // custom handler for non-command text
})
```

Instantiates all services: TelegramClient, MessageStore, MissionManager, AiBackends, ClaudeWorker.

#### Message routing (`processUpdate`)

```
Incoming message
  │
  ├─ Active generation session? → route to _continueGenSession
  │
  ├─ /start → handleStart() → welcome message
  │
  ├─ Custom command match? → custom handler
  │
  ├─ /mission <task> → handleMission()
  │    ├─ Creates mission ticket
  │    ├─ Moves to in-progress/
  │    ├─ Spawns Claude CLI
  │    ├─ Starts heartbeat monitor
  │    └─ Sends "Mission starting" message
  │
  ├─ /externalllm <query> → handleExternalLlm()
  │    └─ Calls DeepSeek SDK → sends result
  │
  ├─ onMessage handler defined? → custom handler
  │
  └─ (default) → handleDefault()
       ├─ DeepSeek fast API (1024 tokens)
       └─ fallback → Claude CLI sync
```

#### Polling loop

```js
async poll() {
  const offset = this.store.loadLastUpdate() + 1;
  const resp = await this.tg.getUpdates(offset);  // long-poll, 30s timeout
  if (!resp.ok) { consErrors++; return; }
  consErrors = 0;
  for (const u of resp.result || []) {
    if (u.update_id > this.store.loadLastUpdate()) {
      this.store.saveLastUpdate(u.update_id);
      await this.processUpdate(u);  // processes sequentially
    }
  }
}
```

**Key behaviors:**
- **Sequential processing:** Each update is `await`ed before the next. If a mission spawn takes 2 seconds, the next message waits. This is acceptable for single-user bots but means: no concurrent message handling.
- **Error resilience:** Consecutive poll errors are counted. After 10 consecutive failures, the server exits (crashes). The shell scripts handle restart.
- **Offset tracking:** `loadLastUpdate() + 1` is used as offset. Telegram delivers only updates with `update_id >= offset`. This means: if processing crashes mid-way, unprocessed messages with higher IDs are re-fetched on next poll (since we only save lastUpdate after processing).

#### Lifecycle (`start` / `stop`)

**`start()`:**
1. Creates all directories (logs, missions/*)
2. Writes PID file
3. Verifies bot token via `getMe()`
4. Recovers in-progress mission monitors
5. Sends startup notification to chat
6. Enters infinite polling loop

**`stop()`** sets `this.running = false`, unwinding the polling loop.

**Signal handlers:** SIGINT and SIGTERM call `stop()`. `uncaughtException` kills the process (exit 1). `unhandledRejection` logs and continues.

---

## 3. Generated Agent Instance

Each agent created by `generate-agent.sh` gets:

### 3.1 `tools/telegram-server.js` (the thin wrapper)

```js
const { AgentServer } = require("/srv/dev/agents/telegram-agent-kit");
const server = new AgentServer("{{AGENT_DIR}}", {
  agentDisplayName: "{{AGENT_DISPLAY_NAME}}",
  projectName: "{{PROJECT_NAME}}",
  roleDescription: "{{AGENT_ROLE}}",
});
server.start();
```

That's it. All logic is in the shared kit. The wrapper only provides identity.

### 3.2 `.env` configuration

```bash
TELEGRAM_BOT_TOKEN=123456:ABCdef...
TELEGRAM_CHAT_ID=987654321
ANTHROPIC_AUTH_TOKEN=sk-...
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
CLAUDE_MAX_BUDGET=2.00
```

### 3.3 Shell scripts (`scripts/`)

| Script | Purpose | Key behavior |
|---|---|---|
| `telegram-start.sh` | Launch server as daemon | `nohup node tools/telegram-server.js >> logs/telegram.log 2>&1 &`, PID file check, stale PID cleanup |
| `telegram-stop.sh` | Kill the server | Reads PID file, `kill`, removes PID file |
| `telegram-restart.sh` | Stop + start | Calls both scripts sequentially |
| `telegram-status.sh` | Health check | Checks if PID is alive, shows log tail |

### 3.4 Shell tools (`tools/`)

| Tool | Purpose | Implementation |
|---|---|---|
| `telegram-send.sh` | Send one-off messages | `curl POST sendMessage`, truncates at 4000 chars |
| `telegram-poll.sh` | Manual poll check | `curl GET getUpdates?offset=...&timeout=5`, stores last ID in `.telegram-last-update` |
| `telegram-poll.sh --watch` | Continuous manual polling | `while true; do poll_once; sleep 3; done` |
| `telegram-inbox.sh` | Message inbox viewer | Parses `logs/messages.jsonl` with `jq`, supports `--all`, `--replied`, `--stats`, `--mark <id>` |
| `telegram-heartbeat.sh` | Send status update | Thin wrapper that calls `telegram-send.sh` with the same arg |
| `mission-summary.sh` | Review mission history | Parses mission `.md` files with metadata extraction, supports `-n N` and `-a` flags |
| `aliases.sh` | Shell shortcuts | `tg-start`, `tg-stop`, `tg-restart`, `tg-status`, `tg-log`, `tg-inbox`, `tg-errors` |

---

## 4. Data Flow: Full `/mission` Lifecycle

```
User sends "/mission fix the login bug on the signup page"
  │
  ▼
Telegram API stores update
  │
  ▼
AgentServer.poll() fetches update (offset=N, timeout=30s)
  │
  ▼
processUpdate():
  ├─ Logs message to messages.jsonl
  ├─ Matches /mission regex
  ├─ Extracts task: "fix the login bug on the signup page"
  │
  ▼
handleMission():
  ├─ MissionManager.create(task) → missions/todo/2026-05-16-7890-fix-the-login-bug-on-the-signup-.md
  ├─ MissionManager.updateMeta(file, { Status: "in-progress" })
  ├─ MissionManager.move(file, missions/in-progress/)
  ├─ MissionManager.appendLog(file, "started", "Starting Claude worker")
  ├─ tg.sendMessage(chatId, "Mission starting...")
  │
  ▼
ClaudeWorker.spawn(task, missionFile, chatId, AGENT_DIR):
  ├─ spawn("claude", ["-p", task, "--output-format", "text", ...])
  ├─ stdout/stderr capture pipes attached
  ├─ on("close"): writes stdout to missions/results/<file>_result.md
  └─ Returns PID
  │
  ▼
ClaudeWorker.startMonitor(missionFile, chatId, PID):
  ├─ Sends initial "Mission in progress" message → captures message_id
  ├─ Every 60s:
  │    ├─ process.kill(PID, 0) → check alive
  │    ├─ If alive: editMessage(chatId, message_id, progressText)
  │    └─ Sets next 60s timeout
  │
  ▼
Claude CLI eventually exits (minutes or hours later)
  │
  ▼
child.on("close", (code, signal)):
  ├─ Writes stdout + stderr to result file
  │
  ▼
Next heartbeat tick detects process dead:
  ├─ MissionManager.getResultContent(missionFile)
  ├─ If result exists:
  │    ├─ tg.sendMessage(chatId, "Mission complete\n\n" + result)
  │    ├─ MissionManager.move(file, missions/done/)
  │    └─ Monitor removed from activeMonitors[]
  ├─ If no result:
  │    ├─ tg.sendMessage(chatId, "Mission process exited with no result")
  │    ├─ MissionManager.move(file, missions/failed/)
  │    └─ Monitor removed from activeMonitors[]
  │
  ▼
User receives result notification on Telegram
```

---

## 5. Error Handling & Resilience

### Poll failures
- Up to 9 consecutive errors are tolerated (logged, continues polling)
- On the 10th consecutive error → `process.exit(1)`
- Shell scripts or process manager must restart

### Claude spawn failures
- `child.on("error")` writes `SPAWN ERROR: <message>` to the result file
- No Telegram notification is sent for spawn failures (gap: the user doesn't know it failed)

### API backend failures
- `handleDefault()` tries DeepSeek API → falls back to Claude CLI sync
- `handleExternalLlm()` only tries DeepSeek SDK — no fallback

### Message send failures
- `sendMessage` and `editMessage` are wrapped in try/catch
- If initial progress message fails, `progressMsgId` stays null and no heartbeats are attempted
- If mid-flight edit fails, a fresh message is created

### Process crash recovery
- PID file survives process death
- Startup reads PID, checks if it's stale, cleans up
- In-progress missions are recovered by checking PID liveness

---

## 6. Current Limitations

1. **Sequential message processing** — one message at a time, no concurrency
2. **No outgoing message queue** — if Telegram is unreachable, messages are lost (no retry)
3. **Full-file rewrite for markReplied** — O(n) for every reply
4. **No rate limiting** — Telegram's ~30 msg/sec limit is not enforced client-side
5. **Polling, not webhooks** — higher latency (~1s avg) and constant connection churn
6. **Single chat ID** — hardcoded in `.env`, no multi-user support
7. **No message deduplication** — if offset saving fails, messages can be processed twice
8. **Mission heartbeat is 60s fixed** — no adaptive interval
9. **No graceful shutdown wait** — stop() just sets a flag; active missions may lose their final heartbeat
10. **Node.js `https` raw sockets** — no HTTP/2, no connection reuse, no keep-alive across poll cycles
11. **No auth beyond bot token** — any Telegram user who finds the bot can send commands
12. **Claude CLI output is buffered entirely in memory** — large outputs could cause memory pressure
13. **No structured telemetry or metrics** — all logging is ad-hoc console.log
