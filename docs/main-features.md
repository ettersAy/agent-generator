# Main Features

## 1. Agent Generation Engine

`tools/generate-agent.sh` creates fully operational AI agents from parameterized templates.

- **Interactive mode** — Step-by-step wizard via Telegram or CLI
- **Config file mode** — Provide a `.env`-style config for automated generation
- **Template system** — `{{PLACEHOLDER}}` substitution across all agent files
- **Dry-run mode** — Preview without creating files

### Generated Agent Includes
- CLAUDE.md with identity and operating instructions
- Telegram bot server (Node.js polling)
- Mission queue system (todo → in-progress → done/failed)
- Memory system with persistent knowledge
- Management scripts (start, stop, status, restart)
- Web dashboard (same as Agent Generator's)

## 2. Queue-Based Mission Execution (v2)

Process-isolated AI mission execution with filesystem-based IPC.

### Architecture
```
Telegram → Server → missions/todo/ → Dispatcher → mission-runner.sh → claude -p
```

### Key Properties
- **Process isolation** — Claude runs via `nohup`, survives crashes of other components
- **File-based IPC** — Mission `.md` files, `.pid` files, `_result.md` files
- **Output to disk** — Claude stdout goes directly to file, zero memory accumulation
- **Concurrency control** — Max 2 simultaneous Claude processes
- **Crash recovery** — Orphan detection and automatic cleanup on startup
- **4-hour stuck timeout** — Missions with dead runners are auto-failed

## 3. Telegram Integration

- **Unified server** — Single Node.js process for polling, routing, and quick AI responses
- **Command routing** — Structured commands (`/generate`, `/mission`, `/queue`, etc.)
- **Quick AI** — Free-text messages get instant Claude responses
- **Notifications** — Missions report completion via Telegram
- **Generation sessions** — Stateful interactive agent creation wizard

## 4. Web Dashboard

Built-in HTTP server with zero external dependencies.

- **Agent overview** — All agents with online/offline status and message counts
- **Mission queue** — Real-time view of todo, in-progress, done, and failed missions
- **Log viewer** — Server and dispatcher logs with filtering
- **Service controls** — Start/stop services from the UI
- **Auto-refresh** — Optional polling for near-real-time updates
- **Mobile responsive** — Works on phones and tablets

## 5. Comprehensive Wiki

Data-driven documentation system served from markdown files.

- Covers all aspects of the system
- Version-controlled alongside code
- Rendered to HTML at request time
- Auto-generated navigation

## 6. Memory System

Persistent file-based memory for long-term knowledge retention.

- **User memory** — User preferences, roles, knowledge
- **Feedback memory** — Lessons learned, corrections, validated approaches
- **Project memory** — Goals, deadlines, milestones
- **Reference memory** — External resources, links, documentation pointers

## 7. Shared Libraries (SOLID)

Single-responsibility modules shared across components.

| Library | Responsibility |
|---------|---------------|
| `tools/lib/env.sh` | Environment loading, path config |
| `tools/lib/logging.sh` | Structured logging, notifications |
| `tools/lib/process.sh` | PID files, process management |
| `tools/lib/missions.sh` | Mission file CRUD, result paths |
| `tools/lib/agents.js` | Agent discovery and status |
| `tools/lib/queue.js` | Queue snapshot, dispatcher status |
| `tools/lib/generation.js` | Agent generation state machine |
