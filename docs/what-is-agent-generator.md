# What Is Agent Generator?

## Identity

**Agent Generator** is an AI-powered factory that creates, configures, and manages other AI dev agents. It lives at `/srv/dev/agents/agent-generator/` and operates through Telegram (`@AgentGenBot`) and a web dashboard.

**Core mission:** Generate fully isolated AI agents that each monitor and manage their own application, complete with Telegram integration, mission execution, and persistent memory.

## What It Does

1. **Agent Generation** — Creates complete AI agent installations from templates, producing a fully operational agent in seconds
2. **Mission Execution** — Queues, dispatches, and executes AI missions using Claude CLI in process-isolated runners
3. **Telegram Integration** — Receives commands and missions via Telegram, sends notifications on completion
4. **Web Dashboard** — Provides real-time visibility into agents, missions, logs, and system health
5. **Self-Management** — Agent Generator is itself an agent — it can generate improvements to its own code

## The Big Picture

```
Agent Generator (@AgentGenBot)
    │
    ├── Generates → Agent A (e.g., @MoussawerAgentBot)
    │                  └── Manages → /srv/dev/moussawer
    │
    ├── Generates → Agent B (e.g., @TamarineBot)
    │                  └── Manages → /srv/dev/tamarine
    │
    └── Self-manages via own mission queue
```

Each generated agent is a complete clone of the architecture with its own:
- Telegram bot (separate token, separate webhook/polling)
- CLAUDE.md identity
- Mission queue (todo → in-progress → done/failed)
- Memory system
- Tools and scripts

## Key Design Philosophy

- **Process isolation over monoliths** — Every Claude mission runs in its own `nohup` process
- **Filesystem as IPC** — Components communicate through `.md`, `.pid`, and `_result.md` files
- **Crash-safe by default** — If anything dies, the rest keeps running; orphans are auto-recovered
- **Zero-dependency web UI** — The dashboard uses only Node.js built-in `http` module
- **Template-driven generation** — New agents are created from parameterized templates, never copy-pasted
