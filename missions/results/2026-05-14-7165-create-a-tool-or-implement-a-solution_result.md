Done. Here's what was implemented:

### The tool: `tools/mission-summary.sh`

A shell script that scans your `missions/{done,failed,in-progress,todo}/` directories and prints a clean summary of your most recent mission(s):

```bash
mission-summary          # Last mission
mission-summary -n 3     # Last 3 missions
mission-summary -a       # All missions
```

Each summary shows: **title**, **status**, **created date**, **source**, the **original request**, last progress event, and resolution (for done/failed missions).

### Files changed (9 files across the system)

| Layer | File | What |
|-------|------|------|
| **Tool** | `tools/mission-summary.sh` | The actual tool (executable) |
| **Template** | `templates/tools/mission-summary.sh.tmpl` | Template for generated agents |
| **Generator** | `tools/lib/generate.sh` | Registered in TEMPLATE_MAP (line 20) |
| **Aliases** | `tools/aliases.sh` | Added `mission-summary` alias |
| **Alias tmpl** | `templates/tools/aliases.sh.tmpl` | Added alias for generated agents |
| **Memory** | `memory/MEMORY.md` | Tool reference in new "Tools" section |
| **Memory tmpl** | `templates/memory/MEMORY.md.tmpl` | Tool reference in "Built-in Tools" section |
| **CLAUDE.md** | `CLAUDE.md` | Session-recall section + startup procedure |
| **CLAUDE tmpl** | `templates/CLAUDE.md.tmpl` | Same reminder for generated agents |

### How agents are reminded

- **Startup procedure** in CLAUDE.md now includes step 2: "Run `mission-summary` to recall what you were last working on"
- **CLAUDE.md** has a "Session Recall" section documenting the alias
- **MEMORY.md** indexes the tool under "Built-in Tools" (for generated agents) or "Tools" (for agent-generator)
- The `aliases.sh` file sources the `mission-summary` shortcut