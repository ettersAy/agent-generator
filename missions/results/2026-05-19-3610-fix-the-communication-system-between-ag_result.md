The mission is complete. Here's the summary:

---

## What was accomplished

### Root cause of message duplication: fixed
The bridge's `setInterval(poll, 5000)` had no guard against concurrent execution. When `execSync('claude -p')` took 1-2 minutes, the interval would fire again and a second `poll()` would process the same messages in parallel. Two races, two copies of every response.

**Fix:** `polling` boolean lock — re-entrant calls are no-ops, lock released in `finally{}`.

### Bridge instance leak: fixed
No PID guard existed. Restarting `telegram-server.js` spawned a second bridge without killing the first. The bridge logs showed 5+ shutdown/startup cycles in a 60-second window.

**Fix:** `checkExisting()` reads the PID file before starting, exits if another instance is alive.

### Claude CLI failing: fixed  
The bridge's `execSync('claude -p')` didn't pass auth env vars from `.env`. Claude needs `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` in its environment.

**Fix:** Load `.env` and pass auth vars explicitly to `execSync`.

### Duplicate Telegram notifications: fixed
Both the MCP `send_message` tool and the target bridge were sending Telegram notifications for the same event.

**Fix:** Removed the notification from MCP `send_message`. The target bridge is the single source of truth.

### Incident report system: built
New shared incident directory at `/srv/dev/agents/_shared/incidents/`, new MCP `report_incident` tool in the shared bridge server, new `agent-incident.sh` shell script, auto-detection in the bridge (files after 5 consecutive errors), and template updates so future generated agents know how to report problems.

### Tested end-to-end
Round-trip message to Tamarine-bot: sent once, processed once, answered in 6 seconds. All 3 agents running with fixed bridges.


### 5. Built central incident report system
- Shared directory: `/srv/dev/agents/_shared/incidents/`
- MCP tool: `report_incident` added to the shared MCP server
- Shell script: `/srv/dev/agents/_shared/tools/agent-incident.sh`
- Bridge auto-detection: files incidents when 5+ consecutive errors occur
- Message type: Bridge handles `type: "incident"` messages
- Template updated: CLAUDE.md.tmpl includes incident reporting instructions

### 6. Tested end-to-end with Tamarine-bot
- Sent test message via MCP → received once (not duplicated)
- Tamarine-bot processed it in 6 seconds
- Response delivered back
- Bridge logs confirm: each message processed exactly once
- All 3 agents running with fixed bridges

## Files Changed

- `tools/agent-bridge.js` — Poll lock, PID guard, env vars for Claude, incident auto-reporting, error counting
- `/srv/dev/agents/_shared/mcp/inter-agent-bridge.js` — Removed duplicate Telegram notification; added report_incident tool
- `templates/CLAUDE.md.tmpl` — Added inter-agent communication and incident reporting section
- `CLAUDE.md` — Added inter-agent communication architecture doc
- `memory/MEMORY.md` — Added incident system link
- `memory/inter-agent-incident-system.md` — New incident system documentation
- `/srv/dev/agents/_shared/tools/agent-incident.sh` — New shell-based incident CLI
- `tools/agent-bridge.js` (tamarine-bot, mouss-ai) — Copied fixed bridge to all agents

## Verification

- No duplicates: each message appears exactly once as "Processing:" in bridge logs
- Bridges healthy: all 3 agents report bridge RUNNING
- Incident system: test incident filed at `/srv/dev/agents/_shared/incidents/`
- Round-trip test: message sent → received → answered → returned in < 10 seconds

## Issues

- `report_incident` MCP tool not recognized in this session (client-side tool cache), but shell script works and MCP code is correct for future sessions
- Old messages in agent-generator bridge log show Claude CLI failures — these are legacy messages from before env fix; new messages work correctly
