# Important Workflows

## Workflow 1: Agent Generation

```
User (Telegram)                Agent Generator                  Filesystem
───────────────                ────────────────                  ──────────
Send "/generate
  --interactive"
       │                              │
       │    ┌─────────────────────────┘
       │    │ unified-server.js detects command
       │    │ Creates generation session in memory
       │    │
       │    │  "What's the agent name?"
       │────│────────────────────────────→  (Telegram reply)
       │    │
 "my-bot"   │
       │────│→
       │    │  Stores: AGENT_NAME=my-bot
       │    │  "What's the project directory?"
       │    │
 ... (continues for all 12 fields) ...
       │    │
       │    │  All values collected
       │    │  Writes /tmp/gen-config.env
       │    │  Runs: bash tools/generate-agent.sh --config /tmp/gen-config.env
       │    │                        │
       │    │                        ├── Reads templates/
       │    │                        ├── Substitutes {{PLACEHOLDER}}s
       │    │                        ├── Creates /srv/dev/agents/my-bot/
       │    │                        └── Writes all agent files
       │    │
       │    │  "Agent 'my-bot' generated! Start with: cd /srv/dev/agents/my-bot && tg-start"
       │────│────────────────────────────→  (Telegram reply)
       │    │
       │    │  Records in memory/generated-agents.md
```

### Config File Flow

```
User provides URL → Server fetches → Validates 12 required vars → Runs generator
```

## Workflow 2: Mission Execution (Full Lifecycle)

```
User: "/mission fix the login bug"
       │
       ▼
unified-server.js:
  1. Generates mission ID: 2026-05-19-1432-fix-the-login-bug
  2. Creates: missions/todo/2026-05-19-1432-fix-the-login-bug.md
  3. Replies: "Mission queued (ID: 2026-05-19-1432-fix-the-login-bug)"
       │
       ▼ (within 5 seconds)
mission-dispatcher.sh:
  4. Detects new file in todo/
  5. Moves to: missions/in-progress/2026-05-19-1432-fix-the-login-bug.md
  6. Spawns: nohup bash tools/mission-runner.sh <path> &
  7. Stores runner PID in: missions/in-progress/2026-05-19-1432-fix-the-login-bug.pid
       │
       ▼
mission-runner.sh:
  8. Reads mission file
  9. Builds prompt (mission path + autonomy instructions)
  10. Executes: claude -p "$prompt" > missions/results/2026-05-19-1432-fix-the-login-bug_result.md 2>&1
       │
       ▼
Claude CLI:
  11. Reads CLAUDE.md (agent context)
  12. Reads mission file (task context)
  13. Executes tasks autonomously
  14. Writes structured result to output file
  15. Exits
       │
       ▼
mission-runner.sh (resumes after Claude exits):
  16. Reads result file
  17. Extracts summary from ## Accomplished section
  18. Sends Telegram notification:
      "Mission complete: fix the login bug
       Result: Fixed auth middleware, updated tests, deployed to staging"
  19. Moves mission to: missions/done/2026-05-19-1432-fix-the-login-bug.md
  20. Cleans up .pid file
```

## Workflow 3: System Startup

```
scripts/telegram-start.sh:
  1. Source tools/lib/env.sh        ← Load paths, env vars
  2. Source tools/lib/logging.sh    ← Log helpers
  3. Source tools/lib/process.sh    ← PID management
  4. Check if already running (PID files)
  5. Start unified-server.js in background
     - Write .unified-server.pid
  6. Start mission-dispatcher.sh in background
     - Write .mission-dispatcher.pid
     - Dispatcher recovers orphaned missions on startup
  7. Report status to user
```

## Workflow 4: System Shutdown

```
scripts/telegram-stop.sh:
  1. Read .unified-server.pid → kill process
  2. Read .mission-dispatcher.pid → kill process
  3. Remove PID files
  4. Note: Running Claude processes are NOT killed
     (they continue independently and will be recovered on next start)
```

## Workflow 5: Health Check

```
scripts/telegram-status.sh:
  1. Check unified-server.js (PID file exists, process alive)
  2. Check mission-dispatcher.sh (PID file exists, process alive)
  3. For each agent in /srv/dev/agents/:
     - Check .telegram-server.pid
     - Report online/offline
  4. Count missions: todo N, in-progress M, done X, failed Y
  5. Check web dashboard (PID file, process alive)
  6. Print formatted status report
```

## Workflow 6: Crash Recovery

```
Scenario: Server crashes while 2 missions are running

Before crash:
  - unified-server.js: running
  - dispatcher: running
  - Runner A (PID 1234): executing mission-1
  - Runner B (PID 1235): executing mission-2

Crash: Node.js server + dispatcher both die
  - Runners A and B continue (nohup, independent processes)
  - Telegram bot goes offline (no new missions accepted)

After crash (runners finish):
  - Runner A finishes → sends Telegram notification → moves mission-1 to done/
  - Runner B finishes → sends Telegram notification → moves mission-2 to done/

Restart: tg-start
  - Server starts fresh
  - Dispatcher starts → scans in-progress/
  - Finds no orphaned missions (runners already cleaned up)
  - System back to normal
```

## Workflow 7: Agent Self-Management

Agent Generator can improve itself through its own mission system:

```
User: "/mission add a new feature to the web dashboard"

1. Mission queued in Agent Generator's own queue
2. Dispatcher picks it up, spawns Claude
3. Claude (this agent) edits web-dashboard.js
4. Claude commits changes to git
5. Result: Agent Generator has improved itself
```
