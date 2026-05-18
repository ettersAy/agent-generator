Now I have the full picture. Here's the complete status report:

---

## Mission Results: Merge Server AI + Web Dashboard

### What was accomplished (from the first mission before SIGTERM killed it)

**1. Shared library: `telegram-agent-kit/`** — 7 well-structured modules, all under 320 lines:
| Module | Lines | Responsibility |
|--------|-------|----------------|
| `index.js` | 316 | `AgentServer` base class — message routing, polling, lifecycle |
| `config.js` | 61 | Config loader from `.env` |
| `telegram-client.js` | 97 | Telegram Bot API wrapper |
| `mission-manager.js` | 92 | Mission ticket CRUD |
| `claude-worker.js` | 212 | Claude CLI spawn + heartbeat monitors |
| `ai-backends.js` | 145 | DeepSeek API + Anthropic SDK + CLI fallback |
| `message-store.js` | 70 | JSONL message persistence |

**2. Both agents refactored** to thin wrappers (~170-290 lines) using the kit — zero duplicated server code.

**3. Web dashboard built and running** at `http://localhost:3099` — sidebar lists agents, click to view messages, API at `/api/agents` and `/api/agents/{name}/messages`.

### What's running right now
- **`@AgentGenBot`** (PID 73344) — agent-generator, logging correctly
- **`@MoussAIBot`** (PID 73296) — mouss-ai, running but logging to `/tmp/mouss-ai-test.log` (misconfigured)
- **Web Dashboard** (PID 73523) — port 3099, shows both agents

### Issues found
1. **Mouss-ai was started manually** with stdout/stderr redirected to `/tmp/mouss-ai-test.log` instead of its proper `logs/telegram.log`. Needs a proper restart via `scripts/telegram-start.sh`.
2. **agent-generator `.env` has `ANTHROPIC_AUTH_TOKEN=` empty** — all AI responses fail with "API key not configured", falling back to Claude CLI which sometimes also fails. This is why your `/mission` commands spawned workers but they couldn't complete properly.
3. **generate-agent.sh is 285 lines** — it's the only file worth splitting, but it's a shell script with a single clear responsibility (template substitution).

What would you like me to do? I can:
- Restart mouss-ai properly so it logs correctly
- Fix the agent-generator `.env` with the proper API key
- Do the deeper code split/refactor on `generate-agent.sh`