# Architecture Details

## Process Isolation Model

The system uses a **multi-process architecture** where each component runs independently:

```
┌──────────────────────────────────────────────────────────┐
│                    Operating System                       │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ unified-     │  │ mission-     │  │ web-         │   │
│  │ server.js    │  │ dispatcher.sh│  │ dashboard.js │   │
│  │ (Node.js)    │  │ (Bash)       │  │ (Node.js)    │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘   │
│         │                  │                              │
│         │    ┌─────────────┴──────────────┐              │
│         │    │     mission-runner.sh      │              │
│         │    │  ┌──────────────────────┐  │              │
│         │    │  │   claude -p (nohup)  │  │  (up to 2)  │
│         │    │  └──────────────────────┘  │              │
│         │    └────────────────────────────┘              │
└─────────┴────────────────────────────────────────────────┘
```

### Why Multi-Process?

1. **Crash isolation** — If the Telegram server crashes, running Claude missions continue
2. **Memory isolation** — Claude's memory usage doesn't affect the Node.js event loop
3. **Clean lifecycle** — Each component has a simple start/stop/monitor cycle
4. **Language flexibility** — Node.js for I/O, Bash for process management, Claude CLI for AI

## File-Based IPC (Inter-Process Communication)

All communication between components happens through the filesystem:

```
 missions/todo/           missions/in-progress/       missions/results/
 ┌──────────────┐        ┌──────────────────┐        ┌──────────────┐
 │ mission.md   │──→    │ mission.md        │──→    │ result.md    │
 │ (created by  │        │ mission.pid       │        │ (Claude      │
 │  server)     │        │ (runner PID)      │        │  output)     │
 └──────────────┘        └──────────────────┘        └──────────────┘
```

### File Types

| File | Writer | Reader | Purpose |
|------|--------|--------|---------|
| `missions/todo/*.md` | unified-server.js | dispatcher | New mission requests |
| `missions/in-progress/*.md` | dispatcher | runner | Active mission context |
| `missions/in-progress/*.pid` | runner | dispatcher | Runner process ID |
| `missions/results/*_result.md` | Claude (via shell) | runner, dashboard | Mission output |
| `.unified-server.pid` | telegram-start.sh | status, stop | Server process ID |
| `.mission-dispatcher.pid` | dispatcher | status, stop | Dispatcher process ID |
| `.web-dashboard.pid` | web-dashboard-start.sh | status, stop | Dashboard process ID |

### Why Filesystem IPC?

- **Crash-safe** — A file persists even if the writer crashes
- **Observable** — `ls`, `cat`, `tail` give instant visibility
- **No serialization** — Markdown is human-readable and Claude's native format
- **No network** — No ports, no sockets, no connection management
- **Recoverable** — On restart, dispatcher reads `in-progress/` and recovers orphans

## Mission Execution Flow (Detailed)

```
1. User sends "/mission Deploy the app" via Telegram
2. unified-server.js:
   - Creates missions/todo/2026-05-19-1234-deploy-the-app.md
   - Writes mission metadata (created time, source, status)
   - Acknowledges to user: "Mission queued: deploy-the-app"

3. mission-dispatcher.sh (polling every 5s):
   - Detects new .md in todo/
   - Checks concurrency (max 2 running)
   - Moves file to in-progress/
   - Updates status to "dispatched"
   - Spawns: nohup bash tools/mission-runner.sh <file> &
   - Records runner PID

4. mission-runner.sh:
   - Reads mission file
   - Builds Claude prompt:
     "Read and execute the mission file at: /path/to/mission.md
      You are an AI agent with full authorization. Work autonomously..."
   - Runs: claude -p "$prompt" > result_file 2>&1
   - Claude reads CLAUDE.md (loaded from cwd), reads mission, executes tasks
   - When Claude exits:
     - Reads result file
     - Sends Telegram notification with summary
     - Moves mission to done/ or failed/

5. User receives Telegram notification:
   "Mission complete: deploy-the-app
    Result: App deployed successfully to https://..."
```

## Concurrency Control

The dispatcher enforces `MAX_CONCURRENT=2`:

```bash
RUNNING=$(count_running_runners)  # Count alive runner PIDs
if [ "$RUNNING" -ge "$MAX_CONCURRENT" ]; then
  continue  # Skip this poll cycle
fi
```

This prevents resource exhaustion. Missions queue up in `todo/` until a slot opens.

## Crash Recovery

On dispatcher startup:

```bash
for mission_file in missions/in-progress/*.md; do
  pid_file="${mission_file%.md}.pid"
  result_file="missions/results/$(basename "${mission_file%.md}")_result.md"

  if pid_is_alive "$pid_file"; then
    continue  # Runner still active, leave it alone
  fi

  if [ -f "$result_file" ] && [ -s "$result_file" ]; then
    # Claude finished, result exists — send notification and move to done
    notify_and_move_to_done "$mission_file"
  else
    # Runner dead, no result — move to failed
    move_to_failed "$mission_file" "Runner died without result"
  fi
done
```

## Stuck Mission Timeout

Missions running longer than 4 hours with a dead runner PID are automatically moved to `failed/`. This handles cases where the runner process died but the `.pid` file remains.

## Notification Reliability

The shell script handles notifications AFTER Claude exits — it does NOT depend on Claude remembering to send a Telegram message. This is a deliberate design choice because:

1. Claude may crash mid-execution
2. Claude may forget to send a notification
3. The result file is the source of truth, not Claude's behavior

The runner script always sends a notification regardless of Claude's actions.
