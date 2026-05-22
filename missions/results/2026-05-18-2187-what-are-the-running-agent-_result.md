Now I have the full picture. Let me write the result summary.

## Accomplished — what was done

Identified all running AI agents and their processes on the system:

### Running Agents

| Agent | Directory | Bot Username | PID | Uptime | Telegram |
|-------|-----------|-------------|-----|--------|----------|
| **agent-generator** | `/srv/dev/agents/agent-generator/` | `@AgentGenBot` | 38087 | ~2h 44m | Active — polling chat 7469502951 |
| **mouss-ai** | `/srv/dev/agents/mouss-ai/` | `@MoussAIBot` | 38088 | ~2h 44m | Active — polling chat 7469502951 |

### Supporting Processes

- **unified-server** (agent-generator): PID 38079 — orchestrates message routing
- **mission-dispatcher** (agent-generator): PID 39514 — watches todo/ queue, spawns runners
- **mission-runner** (agent-generator): PID 58546 — currently executing this mission

### Other directories under `/srv/dev/agents/`

- `logs/` — shared logs directory
- `missions/` — shared missions directory
- `telegram-agent-kit/` — a library/toolkit, not a running agent

### Summary

**2 agents running**, both connected to the same Telegram chat (7469502951). Both can receive and respond to Telegram messages. The agent-generator handles agent creation and mission queuing; mouss-ai serves as the dev agent for the Moussawer project.

## Files Changed

None — read-only investigation.

## Verification

Run `bash /srv/dev/agents/agent-generator/scripts/telegram-status.sh` to confirm the status snapshot. Both agent processes are visible via `ps aux | grep telegram-server`.

## Issues

None.
