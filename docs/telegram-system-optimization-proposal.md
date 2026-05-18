# Telegram Messaging System — Optimization & Feature Proposal

> **Status:** Proposal | **Date:** 2026-05-16 | **Target:** telegram-agent-kit v2.0.0

---

## 0. Design Philosophy

The current system (v1) is optimized for **simplicity** — zero external dependencies for HTTP, filesystem as database, one process per agent. This served well but has 13 known limitations (see detailed doc).

v2 optimizes for **reliability, observability, and extensibility** while keeping the single-process-per-agent isolation model. Webhooks are added as an option, not a replacement — polling remains the default for agents behind NAT/firewalls.

---

## 1. Phase 1 — Reliability & Resilience

### 1.1 Outbound Message Queue with Retry

**Current:** `sendMessage()` fires and forgets. If Telegram is unreachable, the message is lost. No retry.

**Proposed:**
- All outbound messages go through a persistent **SQLite-backed queue**
- Queue schema: `(id, chat_id, text, parse_mode, priority, attempts, max_attempts, next_retry_at, created_at, status)`
- Worker drains the queue with **exponential backoff**: 1s → 2s → 4s → 8s → 16s → give up after 5 attempts
- High-priority messages (mission results) jump the queue
- Failed messages after max attempts → logged to dead-letter file for manual inspection
- Queue persisted to SQLite so messages survive process restart

**Tradeoff:** SQLite is a new dependency. Mitigation: use `better-sqlite3` (native, synchronous, no async overhead for this use case).

### 1.2 Graceful Shutdown

**Current:** `stop()` sets `running = false`. Active heartbeat monitors are abandoned mid-flight.

**Proposed:**
```
SIGTERM/SIGINT received
  → Set status = "shutting_down"
  → Stop accepting new missions (reply: "Shutting down, try again soon")
  → For each active mission:
       Send final heartbeat: "Server restarting — mission continues. Will reattach."
  → Drain outbound queue (wait up to 30s)
  → Save all state
  → exit(0)
```
- On restart, `recoverMonitors()` reattaches to surviving Claude processes.
- New env var `SHUTDOWN_GRACE_PERIOD_SEC=30` controls max drain time.

### 1.3 Health HTTP Endpoint

**Current:** No way to check agent health except `telegram-status.sh` which only checks PID liveness.

**Proposed:**
- Each agent runs a **localhost-only HTTP server** on a configurable port (default `0` = random)
- Endpoints:
  - `GET /health` → `200 { status, uptime, activeMissions, queueDepth, lastPollAt }`
  - `GET /health/live` → `200 OK` (process alive)
  - `GET /health/ready` → `200 OK` if bot token verified and polling active
  - `GET /metrics` → Prometheus-compatible metrics (message count, mission duration histogram, API latency)
- Port is written to `.health-port` file for shell scripts to discover
- Used by `telegram-status.sh` for rich status output

### 1.4 Structured Logging

**Current:** Ad-hoc `console.log` and `console.error` with timestamp prefix. Errors written to JSONL but not queryable.

**Proposed:**
- All logs are structured JSON: `{ ts, level, msg, traceId, ...context }`
- `traceId` = `update_id` for incoming messages (correlates request → processing → response)
- `traceId` = mission filename for mission-related logs
- Log files: `telegram.log` (all), `errors.log` (ERROR+FATAL only), `missions.log` (mission events only)
- Log rotation: 10MB max, keep 5 rotated files

**Dependency:** `pino` (minimal overhead, ~5KB) or keep it zero-dep with a simple JSON serializer.

---

## 2. Phase 2 — Performance & Scalability

### 2.1 SQLite Message Store

**Current:** `messages.jsonl` — full file rewrite for every `markReplied` call.

**Proposed:**
```sql
CREATE TABLE messages (
  update_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  from_name TEXT,
  username TEXT,
  text TEXT,
  timestamp TEXT NOT NULL,
  replied INTEGER DEFAULT 0,
  processed_at TEXT
);
CREATE INDEX idx_messages_replied ON messages(replied);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
```
- `markReplied` → `UPDATE messages SET replied = 1 WHERE update_id = ?` (O(1), no rewrite)
- `telegram-inbox.sh` → SQL queries via a new `telegram-inbox.js` or sqlite3 CLI
- Migration path: on first startup, detect JSONL → import to SQLite → rename JSONL to `.bak`

### 2.2 Concurrent Message Processing

**Current:** Messages processed one at a time. If mission spawn takes 2s, next message waits.

**Proposed:**
- Configurable concurrency pool (default: 3 workers)
- Each incoming message is enqueued into an **in-memory processing queue**
- Worker pool picks up messages and processes them concurrently
- Missions (long-lived) are handled by a separate pool — mission spawn is fast (~50ms), the actual Claude execution is async
- Concurrent message limit prevents overload: if all workers are busy, queue the message and reply with a "Processing, please wait..." acknowledgment

**Nuance:** The actual bottleneck is Claude CLI — spawning it takes ~500ms. Sequential message processing isn't the real problem for single-user bots. This matters more for multi-user scenarios.

### 2.3 HTTP Keep-Alive / Connection Reuse

**Current:** Every `getUpdates` call opens a new HTTPS connection. Every `sendMessage` does the same.

**Proposed:**
- Use Node.js `http.Agent` with `keepAlive: true` for all Telegram API calls
- Maintain a single agent instance across poll cycles
- This cuts connection setup overhead (TLS handshake) by ~90% for the polling loop
- If switching to a library: `undici` (Node.js native fetch in v18+) or keep raw `https` with agent reuse

### 2.4 Adaptive Heartbeat Interval

**Current:** Fixed 60s heartbeat for all missions, forever.

**Proposed:**
```
Elapsed    | Interval | Rationale
0-5 min    | 30s      | User is likely watching, fast feedback
5-30 min   | 60s      | Settled in, standard monitoring
30 min-2h  | 120s     | Long mission, reduce API calls
2h+        | 300s     | Very long mission, minimal churn
```
- Each heartbeat message shows the elapsed time and the next check-in time
- Customizable via `HEARTBEAT_INTERVALS=30,60,120,300` env var

---

## 3. Phase 3 — Features

### 3.1 Streaming Claude Output

**Current:** All Claude output is buffered in memory, then sent as a single large message when the process exits. The user has no visibility into what Claude is doing for potentially hours.

**Proposed:**
- Stream stdout in **chunks** (line-buffered)
- Every ~5 seconds or every ~500 chars of output (whichever comes first), edit the progress message to show the latest output
- Format:
  ```
  Mission in progress — 12m 30s elapsed
  ─────────────────────────────────────
  Thinking: analyzing the authentication flow...
  Found: bug in validateToken() at auth.ts:142
  Fixing: adding null check for expired tokens
  ...
  (live, scrolls as new output arrives)
  ─────────────────────────────────────
  ```
- On mission complete, send the final result as a separate message (so the streaming message doesn't grow unbounded)
- Use Telegram's `editMessageText` for streaming; on edit failure, create a new streaming message

**Implementation note:** This requires changing `claude-worker.js` to buffer chunks and emit events, rather than buffering everything in memory until close. The heartbeat timer and streaming can coexist — heartbeat shows progress stats, streaming shows the actual output.

### 3.2 Multi-User Authorization

**Current:** No auth — anyone who discovers the bot can send commands.

**Proposed:**
- `.env` adds: `ALLOWED_USERS=123456789,987654321` (Telegram user IDs)
- On each incoming message: check `message.from.id` against the allowed list
- Unauthorized users get: "Access denied. Your user ID is <id>. Contact the bot owner."
- Optional: `ALLOWED_USERNAMES=@ettersAy,@dev2` as alternative
- For agent-to-agent scenarios (see §3.5), agents authenticate via a shared secret in the message

### 3.3 Webhook Mode (Optional)

**Current:** Polling only. Higher latency, constant connection churn.

**Proposed:**
- If `WEBHOOK_URL` is set in `.env`, the server switches to webhook mode
- On startup: calls `setWebhook` with the URL + secret token
- Sets up a local HTTP server to receive webhook events
- Webhook payload is processed exactly like a polled update — same `processUpdate` path
- Falls back to polling if webhook setup fails (resilience)
- Secret token in webhook header for verification (Telegram's `secret_token`)

**When to use:** Agents deployed on VPS with public IPs or behind a reverse proxy. Reduces latency from ~1s to ~50ms. Reduces outbound connections from constant polling to on-demand.

### 3.4 Scheduled Missions (Cron)

**Current:** Missions are triggered only by Telegram messages.

**Proposed:**
- `.env` adds cron schedule: `CRON_MISSIONS=0 9 * * 1-5|Check production health,0 18 * * *|Daily summary`
- Format: `<cron>|<task description>`
- Server parses cron expressions, schedules using `setTimeout` with calculated next-fire-time
- Recurring missions behave identically to `/mission` tasks — mission files, heartbeats, results
- New command: `/cron list` — shows scheduled missions
- New command: `/cron trigger <index>` — manually trigger a scheduled mission

**Implementation:** Use `cron-parser` package for expression parsing, or keep it zero-dep with a simple 5-field parser (the syntax is well-defined).

### 3.5 Agent-to-Agent Messaging

**Current:** Agents are completely isolated. No cross-agent collaboration.

**Proposed:**
- `/mission @agent-name <task>` — delegates a task to another agent
- The sending agent:
  1. Resolves `@agent-name` to a Telegram chat ID (from `AGENT_DIRECTORY` env or a shared registry file)
  2. Sends a message to the target agent's bot: `[DELEGATE from @AgentA] <task>`
  3. Logs the delegation in its own mission file
  4. Optionally polls the target agent for status updates
- The receiving agent processes it like a normal `/mission` but adds `Source: agent-to-agent` and `From: @AgentA` to the mission metadata
- Registry: `/srv/dev/agents/agent-registry.json` shared across all agents:
  ```json
  {
    "agent-generator": { "chat_id": 123456789, "bot_username": "@AgentGenBot" },
    "mouss-ai": { "chat_id": 987654321, "bot_username": "@MoussawerAgentBot" }
  }
  ```

### 3.6 Web Dashboard

**Current:** All interaction is via Telegram. No browser-based visibility.

**Proposed:**
- Each agent serves a simple **read-only dashboard** on its health HTTP port
- Pages:
  - `/` — Overview: agent name, project, uptime, active missions, recent messages
  - `/missions` — List all missions with status, elapsed time, filterable
  - `/missions/<id>` — Single mission view with full detail and live output
  - `/inbox` — Recent messages with reply status
- Served as static HTML with inline JSON data (zero JS framework)
- Dark terminal-inspired theme
- Protected by a simple token in URL: `/dashboard?token=<DASHBOARD_TOKEN>`

### 3.7 Mission Chaining & Workflows

**Current:** Each mission is standalone. No way to trigger follow-up work.

**Proposed:**
- In a mission description, add: `[then: "deploy to staging"]` or `[on-success: "run tests"]`
- When a mission completes successfully, the chained mission is automatically created
- `[on-failure: "alert @admin"]` creates a notification mission on failure
- Simple DAG: each mission can have one `on-success` and one `on-failure` chain
- New file `missions/chains/` stores chain definitions for recurring workflows

---

## 4. Phase 4 — Developer Experience

### 4.1 Plugin System

**Current:** Custom commands must be passed in the `customCommands` constructor option. No hot-reload.

**Proposed:**
- Each agent can have a `plugins/` directory
- A plugin is a single `.js` file that exports `{ name, commands, onMessage, onStartup, onShutdown }`
- Plugins are auto-loaded on startup
- Example plugin `plugins/deploy.js`:
  ```js
  module.exports = {
    name: "deploy",
    commands: {
      "/deploy": async function(chatId, args, updateId) {
        // spawn deploy logic
      }
    },
    onStartup: async (server) => { server.log("Deploy plugin loaded"); }
  };
  ```
- Hot-reload: `POST /plugins/reload` on the health HTTP endpoint, or `/reload-plugins` command

### 4.2 Test Mode / Telegram Simulator

**Current:** Testing requires a real Telegram bot token and sending real messages.

**Proposed:**
- `TEST_MODE=true` in `.env` → server starts without connecting to Telegram
- A **simulator CLI** repl: `node tools/simulate.js`
  - Type messages as if you were the user: `you: /mission fix the bug`
  - See agent responses inline: `agent: Mission starting...`
  - `you: /exit` to quit
- Allows full local testing without network or bot token
- Simulator reuses the exact same `processUpdate` code path

### 4.3 Mission Templates

**Current:** Every mission is free-form text.

**Proposed:**
- `missions/templates/` directory
- Template file: `deploy.md` containing pre-written mission instructions
- `/mission @template deploy` expands the template
- Templates can have variables: `deploy to {{ENV}}` → `/mission @template deploy --env staging`
- Saves time for common recurring tasks

---

## 5. Implementation Priority Matrix

| Priority | Feature | Effort | Impact | Risk |
|---|---|---|---|---|
| **P0 — Now** | Outbound message queue with retry | M | High | Low |
| **P0 — Now** | Graceful shutdown | S | High | Low |
| **P0 — Now** | Structured logging with trace IDs | S | High | Low |
| **P1 — Next** | Health HTTP endpoint | S | Medium | Low |
| **P1 — Next** | Adaptive heartbeat interval | XS | Medium | Low |
| **P1 — Next** | Multi-user authorization | S | Medium | Low |
| **P1 — Next** | Streaming Claude output | L | High | Medium |
| **P2 — Soon** | SQLite message store | M | Medium | Medium |
| **P2 — Soon** | Plugin system | M | High | Medium |
| **P2 — Soon** | Web dashboard | L | Medium | Low |
| **P3 — Later** | Webhook mode | M | Low | Medium |
| **P3 — Later** | Scheduled missions | M | Medium | Low |
| **P3 — Later** | Agent-to-agent messaging | L | Medium | High |
| **P3 — Later** | Mission chaining | S | Low | Low |
| **P4 — Nice** | Test mode / simulator | M | Low | Low |
| **P4 — Nice** | Mission templates | S | Low | Low |
| **P4 — Nice** | Concurrent message processing | S | Low | Low |

> **Effort:** XS=hours, S=1-2 days, M=3-5 days, L=1-2 weeks
> **Risk:** likelihood of introducing breaking changes or instability

---

## 6. Migration Strategy

### Backward Compatibility
- All new features are opt-in via `.env` configuration
- Default behavior matches v1 exactly
- SQLite migration is automatic on first v2 startup
- JSONL files are backed up before migration

### Rollout Plan
1. **Week 1:** Implement P0 items (queue, shutdown, logging) — release v2.0.0-alpha
2. **Week 2:** Test on agent-generator itself (dogfooding)
3. **Week 3:** Implement P1 items — release v2.0.0-beta
4. **Week 4:** Upgrade all generated agents via `generate-agent.sh --upgrade`
5. **Week 5+:** Implement P2-P4 based on feedback

### Upgrade Path for Existing Agents
```bash
# In each agent directory:
cd /srv/dev/agents/my-agent
npm install /srv/dev/agents/telegram-agent-kit  # re-link shared kit
tg-restart  # restart picks up new kit version
```

---

## 7. Architecture Diagram: v2

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          telegram-agent-kit v2                           │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                        AgentServer                                │   │
│  │  ┌──────────────┐  ┌───────────┐  ┌────────────┐  ┌───────────┐  │   │
│  │  │ MessageRouter │  │ WorkerPool│  │ CronEngine │  │ PluginMgr │  │   │
│  │  └──────┬───────┘  └─────┬─────┘  └─────┬──────┘  └─────┬─────┘  │   │
│  │         │                │              │               │         │   │
│  │  ┌──────┴────────────────┴──────────────┴───────────────┴──────┐  │   │
│  │  │                      Core Services                          │  │   │
│  │  │  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ ┌────────┐ │  │   │
│  │  │  │Telegram  │ │ Outbound │ │Message │ │Mission│ │Claude  │ │  │   │
│  │  │  │Client    │ │Queue     │ │Store   │ │Manager│ │Worker  │ │  │   │
│  │  │  │(poll/    │ │(SQLite   │ │(SQLite)│ │(files)│ │(stream)│ │  │   │
│  │  │  │ webhook) │ │ +retry)  │ │        │ │       │ │        │ │  │   │
│  │  │  └──────────┘ └──────────┘ └────────┘ └──────┘ └────────┘ │  │   │
│  │  │  ┌──────────┐ ┌──────────┐ ┌────────────────────┐          │  │   │
│  │  │  │AiBackends│ │Health    │ │Structured Logger   │          │  │   │
│  │  │  │(SDK+HTTP)│ │HTTP API  │ │(JSON+traceId)      │          │  │   │
│  │  │  └──────────┘ └──────────┘ └────────────────────┘          │  │   │
│  │  └────────────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  New v2 components:              Changed v1 components:                  │
│  • OutboundQueue (SQLite)        • TelegramClient (+webhook support)     │
│  • HealthAPI (localhost HTTP)    • MessageStore (JSONL → SQLite)        │
│  • WorkerPool (concurrency)      • ClaudeWorker (streaming output)      │
│  • CronEngine (scheduled)       • Logger (ad-hoc → structured)          │
│  • PluginManager (extensible)                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Second-Pass Review & Refinement

> **Review conducted:** 2026-05-16 | **Method:** Critical re-examination of every proposal against actual user needs, failure modes, and implementation cost.

---

### 8.1 What's Actually Broken? (First Principles)

Before optimizing, define the real pain points for a single developer managing ~5-10 agents:

| Pain Point | Severity | Current Mitigation |
|---|---|---|
| "I sent /mission and don't know if it's working" | **High** | No visibility until mission finishes (hours later) |
| "How long has this mission been running?" | **Low** | Heartbeat messages show elapsed time |
| "My agent stopped responding" | **Medium** | `tg-status` checks PID only; no deep health check |
| "I accidentally sent a bad /mission; can I stop it?" | **Medium** | No cancel mechanism; must SSH in and `kill` |
| "Can I see all missions across all agents?" | **Low** | Must SSH into each agent and run `mission-summary` |
| "Did my message get lost?" | **Very Low** | Telegram is 99.9%+ reliable; outbound messages rarely fail |
| "Someone found my bot and is spamming it" | **Low** | Unlikely for private bots; no auth currently |

**Key insight:** The #1 problem by a wide margin is **blindness during long missions**. The user sends `/mission` and gets a heartbeat, but has zero visibility into what Claude is actually doing — reading files, running commands, writing code, or stuck in a loop. **Streaming output** (§3.1) solves this and should be the top priority.

### 8.2 Priority Re-ranking

Based on actual user impact, not theoretical best practices:

| New Rank | Feature | Old Rank | Why moved |
|---|---|---|---|
| **P0** | Streaming Claude output | P1 | #1 user pain point. Transforms UX from blind to visible. |
| **P0** | Mission cancel + concurrent limit | _Missing_ | Cannot stop bad missions; no guard against process flood. |
| **P0** | Structured logging with trace IDs | P0 | Stays P0 — enables all debugging. Zero behavior change. |
| **P1** | Graceful shutdown | P0 | Demoted: agents rarely restart; P0 is over-prioritized. |
| **P1** | Health HTTP endpoint | P1 | Stays P1 — enables monitoring. |
| **P1** | Multi-user authorization | P1 | Stays P1 — security hygiene. |
| **P1** | Adaptive heartbeat interval | P1 | Stays P1 — small change, nice UX. |
| **P2** | Outbound message queue | **P0 → P2** | **Over-engineered for this scale.** Telegram is highly reliable. In-memory retry (3 attempts) is sufficient. SQLite persistence for messages that almost never fail is unnecessary complexity. |
| **P2** | Mission chaining + session persistence | P3 | Session persistence between missions is more valuable than chaining. |
| **P2** | Plugin system | P2 | Stays P2 — extensibility for agent-specific commands. |
| **P3** | SQLite message store | P2 | Demoted: JSONL full-rewrite for 50 msgs/day is a non-issue. Only matters at 10,000+ msgs/day. |
| **P3** | Scheduled missions | P3 | Nice to have, not critical. |
| **P3** | Mission templates | P4 | Simple, high convenience-to-effort ratio. |
| **P4** | Web dashboard | P2 | Demoted: Telegram IS the dashboard. Separate web UI adds complexity for marginal gain at this scale. Consider a single-file HTML served by the health endpoint instead. |
| **P4** | Test mode / simulator | P4 | Stays P4. |
| **Removed** | Webhook mode | P3 | **Removed.** Polling is simpler, works everywhere, and latency is irrelevant for async missions. Webhooks require TLS + public endpoint — solving a problem this system doesn't have. |
| **Removed** | Agent-to-agent via Telegram | P3 | **Removed.** For same-machine agents, Telegram API routing adds seconds of latency. Replaced with filesystem-based delegation (§8.7). |
| **Removed** | Concurrent message processing | P4 | **Removed.** Single-user bot. Message processing takes <100ms (spawning is async). Concurrency solves no real problem. |

### 8.3 Missed Features (Discovered During Review)

#### 8.3.1 Mission Cancel (`/cancel`)

User sends `/cancel` or replies to a heartbeat message with "cancel":
1. Agent looks up the active mission for that chat
2. Sends `SIGTERM` to the Claude child process
3. Moves mission to `failed/` with reason "Cancelled by user"
4. Sends confirmation: "Mission cancelled after 12m 30s."

Also: `/cancel --force` sends `SIGKILL` if SIGTERM doesn't work within 5 seconds.

#### 8.3.2 Concurrent Mission Limit

`MAX_CONCURRENT_MISSIONS=3` in `.env`. When a 4th `/mission` arrives:
- Reply: "Already running 3 missions. Wait or /cancel one. Active: <list>"
- Prevents accidental process floods (e.g., user taps `/mission` 10 times from message history)

#### 8.3.3 Per-Mission Budget

`/mission --budget 0.50 fix the bug` overrides `CLAUDE_MAX_BUDGET` for that mission only. Prevents a single mission from consuming the entire budget.

#### 8.3.4 Claude Session Persistence

Optional session continuity via Claude CLI's `--session-id`:
- `/mission --continue fix that too` reuses the previous session
- Sessions stored per-chat: `--session-id telegram-chat-<chatId>`
- `/mission --fresh start over` uses `--no-session-persistence` to reset
- This allows iterative development: "fix X" → "now test it" → "deploy" — each with full context

#### 8.3.5 Dead Letter Notification

When the outbound queue (or in-memory retry) fails:
- Next successful poll, append to response: "⚠ 2 messages failed to deliver (retries exhausted). See `logs/dead-letter.log`."
- Dead letter file format: JSONL with timestamp, original message, failure reason

### 8.4 Over-Engineering Critique

#### SQLite for Outbound Queue

**Original proposal:** All outbound messages go through SQLite-backed queue with persistence, retry, priority levels, dead-letter handling.

**Critique:** Telegram Bot API has ~99.95% uptime. For a single-user bot sending ~20 messages/day, the probability of losing a message is ~0.05% (once every ~5 years). Building a SQLite queue for this is solving a problem that effectively doesn't exist.

**Revised approach:**
- In-memory retry: 3 attempts with backoff (1s, 3s, 9s)
- On total failure: log to error log, increment a counter
- No SQLite dependency for the queue
- If the message is a mission result (critical): also write it to `missions/results/` on disk as backup
- This is simpler, has zero new dependencies, and handles the 0.05% case adequately

#### Web Dashboard

**Original proposal:** Multi-page dashboard with mission views, inbox, filtering.

**Critique:** The user interacts with agents via Telegram. A web dashboard means they need to context-switch to a browser. For a single developer, SSH + shell scripts + Telegram are the natural interface.

**Revised approach:**
- Health endpoint serves a **single HTML file** with:
  - Agent name, uptime, active missions
  - Live tail of current mission output (if streaming)
  - Last 10 messages
- No routing, no templates, no multi-page app
- One file, inline CSS, loads JSON from `/health` endpoint
- Accessible at `http://<host>:<port>/` when on local network

### 8.5 Alternative Architecture: Event-Driven Core

Instead of monolithic `AgentServer.processUpdate()` with a giant if/else chain:

```
                    ┌─────────────┐
                    │  EventBus   │
                    │  (EventEmitter)│
                    └──┬──┬──┬──┬─┘
          ┌───────────┘  │  │  └───────────┐
          ▼              ▼  ▼              ▼
    ┌─────────┐  ┌─────────┐  ┌─────────────────┐
    │Telegram │  │Command  │  │ClaudeWorker     │
    │Poller   │  │Router   │  │(subscribes to   │
    │(emits   │  │(subs to │  │ command:mission) │
    │ message)│  │ message)│  └─────────────────┘
    └─────────┘  └─────────┘
                     │
                     ▼
              ┌─────────┐  ┌─────────────────┐
              │Auth     │  │ResponseSender   │
              │(subs to │  │(subs to         │
              │ message)│  │ response:*)     │
              └─────────┘  └─────────────────┘
```

**Benefits:**
- Each component is independently testable
- Plugins are just event subscribers
- No if/else chains — each handler registers for what it cares about
- Adding a feature = adding a subscriber, not modifying a switch statement

**Cost:** Small refactor of `processUpdate` into event emissions. Backward-compatible — the same `processUpdate` can emit events.

**Verdict:** Worth implementing alongside P0 items. The refactor is ~50 lines of change in `index.js`.

### 8.6 Systemd Integration (Simpler Than PID Files)

Replace the entire `telegram-start.sh` / `telegram-stop.sh` / PID file machinery with systemd:

```ini
# /etc/systemd/system/agent-{{AGENT_NAME}}.service
[Unit]
Description={{AGENT_DISPLAY_NAME}} Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /srv/dev/agents/{{AGENT_NAME}}/tools/telegram-server.js
WorkingDirectory=/srv/dev/agents/{{AGENT_NAME}}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier={{AGENT_NAME}}

[Install]
WantedBy=multi-user.target
```

Benefits:
- Automatic restart on crash (no shell script polling needed)
- Log management via `journalctl -u agent-{{AGENT_NAME}}`
- `systemctl status agent-{{AGENT_NAME}}` for health
- Proper shutdown signals
- No PID files, no `nohup`, no stale PID cleanup

The shell scripts become thin wrappers:
```bash
tg-start()   { sudo systemctl start agent-{{AGENT_NAME}}; }
tg-stop()    { sudo systemctl stop agent-{{AGENT_NAME}}; }
tg-status()  { systemctl status agent-{{AGENT_NAME}}; }
tg-log()     { journalctl -u agent-{{AGENT_NAME}} -f; }
```

**Verdict:** Implement as part of agent generation — `generate-agent.sh` creates the systemd unit file. Backward-compatible by keeping shell scripts as wrappers.

### 8.7 Filesystem-Based Agent-to-Agent (Replaces §3.5)

Instead of routing agent-to-agent messages through Telegram:

```
Agent A wants to delegate to Agent B:
  1. Agent A writes a mission file directly to:
     /srv/dev/agents/agent-b/missions/todo/2026-05-16-delegated-from-agent-a.md
  2. Agent B's next poll cycle processes it
  3. Result is written to Agent B's missions/done/
  4. Agent A can read it from there (or Agent B notifies via Telegram)

Configuration:
  AGENT_PEERS=/srv/dev/agents/agent-b,/srv/dev/agents/agent-c
```

This is:
- Instant (no network latency)
- Free (no API calls)
- Survives network outages
- Uses the existing mission file format

Only useful for same-machine agents — which is 100% of the current use case.

### 8.8 The "Week 1 Patch" — 80% Value, 20% Effort

If we can only do 3 things in the first week:

1. **Streaming Claude output** (§3.1) — changes `claude-worker.js` to emit stdout chunks instead of buffering. Edits the heartbeat message every 5 seconds with latest output. ~200 lines changed.

2. **Mission cancel + concurrent limit** (§8.3.1, §8.3.2) — `/cancel` command that SIGTERMs the Claude child. `MAX_CONCURRENT_MISSIONS=3` guard. ~100 lines added.

3. **Structured logging** (§1.4) — wrap `console.log` in a JSON formatter with traceIds. ~50 lines changed.

These three changes fix the biggest pain points with minimal code and zero new dependencies.

### 8.9 Revised Total Dependency Footprint

| Component | v1 Dependencies | v2 Proposed | After Review |
|---|---|---|---|
| HTTP client | `https` (node built-in) | `undici` or `https.Agent` | **Keep `https` with keepAlive** (zero new deps) |
| Message store | JSONL file | SQLite (`better-sqlite3`) | **Keep JSONL** (scale doesn't justify DB) |
| Outbound queue | None (fire/forget) | SQLite + retry logic | **In-memory retry only** (3 attempts, backoff) |
| Logging | `console.log` | `pino` | **Simple JSON serializer** (20 lines, zero deps) |
| Cron engine | None | `cron-parser` | **Simple 5-field parser** (50 lines, zero deps) |
| Health server | None | `http` (built-in) | **`http` (built-in)** — already zero deps |
| SDK (optional) | `@anthropic-ai/sdk` | Same | **Same** — already lazy-loaded |

**After review: zero new npm dependencies.** Everything can be built with Node.js standard library + Claude CLI. This is a significant simplification from the original proposal, which introduced SQLite, pino, cron-parser, and potentially undici.

### 8.10 Final Priority Matrix (Post-Review)

| Priority | Feature | Effort | New Deps | Impact |
|---|---|---|---|---|
| **P0** | Streaming Claude output | M (200 lines) | 0 | Transformative |
| **P0** | Mission cancel + concurrent limit | S (100 lines) | 0 | High |
| **P0** | Structured logging + trace IDs | S (50 lines) | 0 | High |
| **P1** | Health HTTP endpoint | S (80 lines) | 0 | Medium |
| **P1** | Event-driven refactor of processUpdate | S (50 lines) | 0 | Medium |
| **P1** | Multi-user authorization | S (30 lines) | 0 | Medium |
| **P1** | Adaptive heartbeat | XS (30 lines) | 0 | Medium |
| **P1** | Graceful shutdown | S (50 lines) | 0 | Medium |
| **P2** | Claude session persistence | S (40 lines) | 0 | Medium |
| **P2** | Per-mission budget override | XS (20 lines) | 0 | Low |
| **P2** | Plugin system | M (150 lines) | 0 | Medium |
| **P2** | Mission templates | S (60 lines) | 0 | Medium |
| **P3** | Systemd unit generation | XS | 0 | Medium |
| **P3** | Dead letter notification | S (30 lines) | 0 | Low |
| **P3** | Filesystem-based agent-to-agent | S (50 lines) | 0 | Low |
| **P3** | Scheduled missions | M (100 lines) | 0 | Low |
| **P4** | Single-page dashboard | M (150 lines) | 0 | Low |
| **P4** | Test mode / simulator | M (100 lines) | 0 | Low |
| **Removed** | Outbound SQLite queue | — | — | — |
| **Removed** | SQLite message store | — | — | — |
| **Removed** | Webhook mode | — | — | — |
| **Removed** | Agent-to-agent via Telegram | — | — | — |
| **Removed** | Concurrent message processing | — | — | — |

**Total P0 effort:** ~350 lines, zero new dependencies, 3 features.

---

## 9. Summary of Key Decisions from Second-Pass Review

1. **Streaming output is the #1 priority.** It transforms the user experience from "send a mission and hope" to "watch Claude work and intervene if needed." Everything else is secondary.

2. **Zero new dependencies.** SQLite for a 50-message/day bot is over-engineering. In-memory retry handles the rare failure case. JSONL works fine at this scale.

3. **Webhooks and agent-to-agent via Telegram are removed.** They solve problems this system doesn't have (latency sensitivity, distributed agents). Polling is simpler, more reliable, and works everywhere.

4. **Systemd replaces PID files for process management.** More reliable, gives automatic restart, proper logging. Shell scripts become thin wrappers.

5. **Event-driven refactor is small and high-value.** ~50 lines to convert the if/else chain to EventEmitter. Makes plugins and testing natural.

6. **Mission cancel is a critical missing feature.** User has no way to stop a bad mission without SSH. This is as important as starting missions.

7. **The "Week 1 Patch" gives 80% of the value:** streaming output + mission cancel + structured logging. Everything else can follow.

