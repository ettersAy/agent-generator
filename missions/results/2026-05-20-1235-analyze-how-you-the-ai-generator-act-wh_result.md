# Result: Analyze how Agent Generator vs other agents handle Telegram messages

## Accomplished

### Full analysis of message processing across all 3 agents

**1. Quick text responses (non-command) — IDENTICAL across all agents**

All three agents (`agent-generator`, `mouss-ai`, `tamarine-bot`) use the exact same code path from the shared `telegram-agent-kit` base class:

```
processUpdate() → handleDefault() → ai.callDeepSeek()
```

The only parameter that differs is the `agentDisplayName` string in the system prompt:
- Agent Generator: `"You are Agent Generator, a concise AI assistant. Keep responses brief."`
- Mouss-ai: `"You are Mouss-ai, a concise AI assistant. Keep responses brief."`
- Tamarine Bot: `"You are Tamarine Bot, a concise AI assistant. Keep responses brief."`

For quick chat, **no CLAUDE.md is loaded** — it's a raw HTTPS POST to DeepSeek with model `deepseek-chat`, 1024 max tokens, 30s timeout. The AI model has no context about the agent's identity, project, or purpose.

So for plain text messages, all three agents should produce the **same format**. The difference the user perceives comes from the **CLAUDE.md context path** (missions).

**2. Mission execution — THIS IS WHERE THE FORMAT DIFFERS DRAMATICALLY**

| Aspect | Agent Generator | Mouss-ai | Tamarine Bot |
|--------|----------------|----------|--------------|
| **Architecture** | Queue-based (dispatcher daemon) | Direct spawn from Node.js | Direct spawn from Node.js |
| **Prompt** | Wrapped in meta-instructions: "Read and execute the mission file at: ..." plus structured output format | Raw user text passed as-is to `claude -p` | Raw user text passed as-is to `claude -p` |
| **CLAUDE.md** | Loaded (Claude auto-loads from AGENT_DIR) | Loaded (Claude auto-loads from AGENT_DIR) | Loaded (Claude auto-loads from AGENT_DIR) |
| **Output format** | Structured: ## Accomplished, ## Files Changed, ## Verification, ## Issues | Free-form Claude output | Free-form Claude output |
| **Session mode** | `/mission` = continue (`-c`), `/NewMission` = fresh | Fresh only (`--no-session-persistence`) | Fresh only (`--no-session-persistence`) |
| **Result delivery** | Shell script sends Telegram notification AFTER Claude exits | Node.js monitor edits progress message, then sends result | Node.js monitor edits progress message, then sends result |
| **Heartbeat** | None (waits for Claude to exit) | Edits Telegram message every 60s | Edits Telegram message every 60s |
| **Timeout** | No hard timeout | No hard timeout | No hard timeout |

**The agent-generator's mission-runner.sh wraps every user request in this meta-prompt:**

```
Read and execute the mission file at: ${MISSION_FILE}

You are an AI agent with full authorization. Work autonomously — do NOT ask
for permission, just execute every task in the mission completely.

When the mission is fully complete, output a structured summary with:
## Accomplished — what was done
## Files Changed — files modified/created
## Verification — how to confirm the work
## Issues — any problems encountered (or "none")

Do not stop until the entire mission is complete. Use available tools freely.
```

This makes Claude produce a **structured report** every time. Mouss-ai and Tamarine Bot pass the user's raw text directly — Claude responds conversationally, with no enforced structure.

**3. CLAUDE.md "personality" differences**

Each agent's CLAUDE.md defines a completely different identity:

- **Agent Generator** (182 lines): Identity is "AI Agent Factory" — creates/manages other agents. Defines generation workflow, template system, inter-agent communication. Technical and procedural.
- **Mouss-ai** (567 lines): Identity is "Principal AI dev agent for Moussawer" — detailed project knowledge (tech stack, database schema, API architecture, deployment). Very project-specific.
- **Tamarine Bot** (208 lines): Identity is "AI dev agent for student exercise platform" — template-like project description, less detailed.

The CLAUDE.md shapes how Claude CLI responds — so missions produce fundamentally different types of output:
- Agent Generator → agent management results
- Mouss-ai → Moussawer code changes
- Tamarine Bot → TamarineApp code changes

**4. Command set differences**

Agent Generator has 8 custom commands with rich HTML-formatted responses (`<b>`, `<code>`, `<pre>`, `<i>`):
- `/generate --interactive` — 13-step interactive agent creation wizard
- `/generate --config <file>` — Generate from config
- `/list` — All generated agents with status dots
- `/status <name>` — Single agent details
- `/ask <agent> <question>` — Inter-agent messaging
- `/mission <task>` — Continue-mode queue mission
- `/NewMission <task>` — Fresh-mode queue mission
- `/queue` — Mission queue overview
- `/cancel <id>` — Cancel pending

Mouss-ai has 3 commands:
- `/mission` — Direct Claude spawn with prod safety check
- `/externalllm` — DeepSeek SDK (4096 tokens)
- Any text — Quick AI

Tamarine Bot has only the base class defaults:
- `/mission` — Direct Claude spawn
- `/externalllm` — DeepSeek SDK
- Any text — Quick AI

### Root Cause Summary

The format difference the user sees comes from **two things working together**:

1. **Mission prompt wrapping** — Agent Generator wraps every request in a structured-output meta-prompt. Other agents pass raw text.

2. **CLAUDE.md context** — When Claude CLI runs (via /mission or /NewMission), it loads the agent's CLAUDE.md. Agent Generator's CLAUDE.md defines a procedural, tool-oriented identity. Other agents define project-specific dev identities.

A third subtle factor: Agent Generator's `/mission` supports "continue" mode (`claude -c -p`) which resumes the last Claude session, building on previous context. Other agents always use fresh sessions (`--no-session-persistence`).

## Files Changed

- `missions/results/2026-05-20-1235-analyze-how-you-the-ai-generator-act-wh_result.md` — Created this analysis

## Verification

To confirm these findings:
1. Compare the `handleDefault()` code path in `telegram-agent-kit/index.js:126-151` across agents — it's the shared base class, identical for all.
2. Compare `mission-runner.sh:26-39` (agent-generator's prompt wrapper) vs `claude-worker.js:130-178` (mouss-ai direct spawn).
3. Send the same plain text message to all three bots — quick responses will be similar in format.
4. Send `/mission analyze X` to all three — agent-generator will produce a structured report, others will produce free-form output.

## Issues

None.

---

*Analysis completed. The core insight: quick text responses are identical across agents; the format difference is caused by agent-generator's mission-runner.sh prompt wrapper (structured output instructions) + CLAUDE.md identity (agent manager vs project developer).*
