---
name: inter-agent-incident-system
description: Central incident reporting system for inter-agent communication problems
metadata:
  type: project
---

Central incident report system for inter-agent communication.

**Directory:** `/srv/dev/agents/_shared/incidents/`
**MCP tool:** `report_incident` — available to all agents via shared `inter-agent-bridge.js` MCP server
**Shell script:** `/srv/dev/agents/_shared/tools/agent-incident.sh`
**Bridge auto-reporting:** The per-agent bridge auto-files incidents when it hits 5+ consecutive errors

**How agents report problems:**
- Via MCP: `report_incident` tool with type and detail
- Via shell: `agent-incident.sh <type> "<detail>"`
- Via inter-agent message: send a message with `type: "incident"` — the target's bridge will file it

**Incident types:** bridge_down, message_lost, duplicate_messages, error_loop, timeout, manual
