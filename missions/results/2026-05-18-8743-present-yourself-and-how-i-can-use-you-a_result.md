# Mission Result — Present Yourself and How I Can Use You

## Accomplished

### 1. Agent Generator — Who I Am

I am **Agent Generator** (`@AgentGenBot`), the AI agent factory at `/srv/dev/agents/agent-generator/`. My job is to create, configure, and manage other AI dev agents. Each generated agent is a fully isolated AI developer with its own Telegram bot, project context, memories, and mission execution system.

### 2. How to Use Me (Agent Generator Commands)

| Command | Action |
|---------|--------|
| `/start` | Welcome + command list |
| `/generate --interactive` | Walk through creating a new agent step by step |
| `/generate --config <url>` | Create an agent from a config file |
| `/list` | List all generated agents |
| `/status <agent>` | Check an agent's Telegram server health |
| `/mission <task>` | Queue a mission for me to execute (via dispatcher) |
| `/queue` | Show pending/running/completed missions |
| `/cancel <id>` | Cancel a pending mission |
| Any text | Quick AI answer |

From the shell on the server:
```bash
tg-start / tg-stop / tg-restart   # Manage my Telegram server + dispatcher
tg-status                          # Health check
mq                                 # Quick mission queue overview
mission-summary                    # Recall what I was last working on
```

### 3. How to Use Other AI Agents (Like Mouss-ai)

Other generated agents work the same way — each has its own Telegram bot with these commands:

| Command | Action |
|---------|--------|
| `/start` | Welcome + what the agent can do |
| Any text | Quick AI answer |
| Feature/bug reports | The agent auto-creates mission tickets at `missions/in-progress/` |

Each agent is at `/srv/dev/agents/<agent-name>/` and can be managed from the shell:
```bash
cd /srv/dev/agents/<agent-name>
./scripts/telegram-start.sh    # Start the agent's bot
./scripts/telegram-stop.sh     # Stop it
./scripts/telegram-status.sh   # Health check
```

### 4. v2 Mission Execution System — Has It Been Applied to Other Agents?

**Short answer: No, not yet. The v2 system is only on Agent Generator.**

Here is the comparison:

| Component | Agent Generator (v2) | Mouss-ai (current) | Templates (what gets generated) |
|-----------|---------------------|-------------------|-------------------------------|
| **Architecture** | Queue-based, process-isolated | In-process, server-spawned Claude | In-process (v1) |
| **Claude spawning** | `mission-dispatcher.sh` + `mission-runner.sh` (detached `nohup`) | `telegram-server.js` spawns `claude -p` as child process | Same as Mouss-ai (v1) |
| **Output handling** | Direct to disk via shell redirect (zero memory accumulation) | Piped through Node.js stdout/stderr (memory pressure on long missions) | Same as Mouss-ai (v1) |
| **Crash resilience** | Claude survives server/dispatcher crashes | If Node.js crashes, Claude is orphaned | Same as Mouss-ai (v1) |
| **Concurrency** | `MAX_CONCURRENT=2` in dispatcher | No explicit concurrency control | Same as Mouss-ai (v1) |
| **Recovery** | Dispatcher recovers orphans on restart | No recovery mechanism | Same as Mouss-ai (v1) |

**The templates at `/srv/dev/agents/agent-generator/templates/` still contain the v1 architecture** — they use `telegram-server.js.tmpl` (which spawns Claude inline), have no `mission-dispatcher.sh.tmpl`, no `mission-runner.sh.tmpl`. So any new agent generated right now would get the v1 system, not v2.

### 5. Summary of What Changed (v1 → v2)

**Problem v1 solved:** Claude was spawned as a child process of the Node.js server. For missions lasting 30+ minutes, this caused memory pressure, fragile heartbeat monitoring, orphaned processes on crash, and no queue/concurrency control.

**v2 fix:** Completely decoupled architecture:
- Node.js server only writes mission `.md` files to `missions/todo/`
- `mission-dispatcher.sh` (shell daemon) picks them up
- `mission-runner.sh` launches Claude via `nohup` — fully detached, output direct to disk
- Telegram notification sent AFTER Claude exits (no dependency on Claude remembering)

## Files Changed

- Created: `/srv/dev/agents/agent-generator/missions/results/2026-05-18-8743-present-yourself-and-how-i-can-use-you-a_result.md`

## Verification

1. Agent Generator's own tools directory has both v2 components: `mission-dispatcher.sh` and `mission-runner.sh`
2. Mouss-ai's tools directory does NOT have these — it has the v1 `mission-start.sh` and `telegram-heartbeat.sh`
3. The generated-agent registry at `memory/generated-agents.md` shows "(none yet)" — no agents have been formally generated through the factory
4. Templates still carry the v1 architecture

## Issues

None. The mission was a knowledge/information request, fully addressed.
