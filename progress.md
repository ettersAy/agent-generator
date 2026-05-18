# Agent Generator — Progress & Architecture Document

> **Created:** 2026-05-11 (finished 2026-05-12 early AM)
> **Mission:** Build a reusable AI-agent factory that generates and manages Claude-powered dev agents for any app under `/srv/dev/`.

---

## 1. Architecture Analysis

### Source: Mouss-ai Agent (v7)

The Mouss-ai agent at `/srv/dev/agents/mouss-ai` was analyzed as the reference architecture. Key components:

| Component | Path | Purpose |
|-----------|------|---------|
| CLAUDE.md | `CLAUDE.md` | Agent identity, project context, mission workflow, commands |
| Memory System | `memory/` | Persistent knowledge: MEMORY.md index + individual .md files with YAML frontmatter |
| Telegram Server | `tools/telegram-server.js` | Node.js long-polling bot, background Claude CLI workers, heartbeat-based progress editing |
| Start/Stop Scripts | `scripts/telegram-*.sh` | Process management with PID tracking |
| Shell Tools | `tools/telegram-send.sh`, `telegram-inbox.sh`, etc. | Message sending, inbox viewing, polling |
| Aliases | `tools/aliases.sh` | tg-start, tg-stop, tg-restart, tg-status, tg-log, tg-inbox, tg-errors, tg-update |
| Mission Dirs | `missions/{todo,in-progress,done,failed,results}` | Ticket lifecycle tracking |
| Logs | `logs/` | telegram.log, messages.jsonl (JSONL), errors.log |
| Knowledge | `knowledge/` | Validated reference docs about the monitored project |
| Package | `package.json` | Minimal: @anthropic-ai/sdk |

### Telegram Server Architecture (v7)

```
Telegram API (long-poll getUpdates)
  → processUpdate()
    → /start       → Welcome message
    → /mission     → spawnClaude() background worker (no timeout)
                    → startMonitor() heartbeat loop (60s interval, edits ONE message)
                    → on close: send result, move mission to done/failed
    → /externalllm → DeepSeek API (4K tokens)
    → default      → DeepSeek API (1K tokens, fast) → fallback to Claude CLI
```

### What Gets Parameterized

14 placeholders identified as needing substitution for each generated agent:

| Placeholder | Example |
|-------------|---------|
| `{{AGENT_NAME}}` | `mouss-ai` |
| `{{AGENT_DISPLAY_NAME}}` | `Mouss-ai` |
| `{{AGENT_DIR}}` | `/srv/dev/agents/mouss-ai` |
| `{{PROJECT_DIR}}` | `/srv/dev/moussawer` |
| `{{PROJECT_NAME}}` | `Moussawer` |
| `{{PROJECT_DESCRIPTION}}` | `Photography Marketplace` |
| `{{TELEGRAM_BOT_TOKEN}}` | `123:abc` |
| `{{TELEGRAM_CHAT_ID}}` | `123456789` |
| `{{ANTHROPIC_AUTH_TOKEN}}` | `sk-...` |
| `{{ANTHROPIC_BASE_URL}}` | `https://api.deepseek.com/anthropic` |
| `{{GITHUB_REPO}}` | `ettersAy/moussawer` |
| `{{PROD_URL}}` | `https://moussawer.onrender.com` |
| `{{AGENT_USERNAME}}` | `@MoussawerAgentBot` |
| `{{AGENT_ROLE}}` | `Principal AI dev agent for Moussawer` |
| `{{CREATED_DATE}}` | Auto-filled from `date -u` |

---

## 2. Generated File Inventory

### Template Files (16 total)

```
templates/
├── CLAUDE.md.tmpl                          ← Agent identity + mission workflow
├── .env.tmpl                               ← Telegram + AI API config
├── package.json.tmpl                       ← Minimal npm package
├── memory/
│   ├── MEMORY.md.tmpl                      ← Memory index
│   ├── agent-identity.md.tmpl              ← Agent identity memory (with frontmatter)
│   └── incident-reports.md.tmpl            ← Bug fix procedure
├── tools/
│   ├── telegram-server.js.tmpl             ← MAIN SERVER: polling + Claude workers
│   ├── aliases.sh.tmpl                     ← Shell aliases (tg-start, etc.)
│   ├── telegram-send.sh.tmpl               ← Message sending
│   ├── telegram-heartbeat.sh.tmpl          ← Mission status updates
│   ├── telegram-inbox.sh.tmpl              ← Message management
│   └── telegram-poll.sh.tmpl               ← Message checking
└── scripts/
    ├── telegram-start.sh.tmpl              ← Start bot (nohup background)
    ├── telegram-stop.sh.tmpl               ← Stop bot (graceful + force)
    ├── telegram-restart.sh.tmpl            ← Stop + start
    └── telegram-status.sh.tmpl             ← Full health check
```

### Per-Agent Output Structure

```
{AGENT_DIR}/
├── CLAUDE.md              ← Ready to use, fill in project specifics
├── .env                   ← Pre-filled with provided tokens
├── .gitignore             ← Ignores .env, PID files, logs, node_modules
├── package.json           ← @anthropic-ai/sdk
├── node_modules/          ← Auto-installed by generator
├── memory/
│   ├── MEMORY.md
│   ├── agent-identity.md
│   └── incident-reports.md
├── tools/
│   ├── telegram-server.js ← The main bot server
│   ├── aliases.sh
│   ├── telegram-send.sh
│   ├── telegram-heartbeat.sh
│   ├── telegram-inbox.sh
│   └── telegram-poll.sh
├── scripts/
│   ├── telegram-start.sh
│   ├── telegram-stop.sh
│   ├── telegram-restart.sh
│   └── telegram-status.sh
├── knowledge/             ← Empty, ready for project knowledge
├── logs/                  ← telegram.log, errors.log, messages.jsonl (empty)
├── missions/              ← todo/, in-progress/, done/, failed/, results/
└── sandbox/               ← Empty workspace
```

---

## 3. Agent-Generator's Own Structure

```
/srv/dev/agents/agent-generator/
├── CLAUDE.md                  ← Agent-generator identity + how-to
├── .env                       ← @AgentGenBot token (8628309940:AAH...)
├── .gitignore
├── package.json
├── node_modules/
├── progress.md                ← THIS FILE
├── templates/                 ← All 16 .tmpl files (the factory blueprints)
├── tools/
│   ├── generate-agent.sh      ← THE ENGINE: reads config, substitutes, writes agent
│   ├── telegram-server.js     ← Agent-generator's own bot server
│   ├── telegram-send.sh
│   ├── telegram-heartbeat.sh
│   ├── telegram-inbox.sh
│   ├── telegram-poll.sh
│   └── aliases.sh
├── scripts/
│   ├── telegram-start.sh
│   ├── telegram-stop.sh
│   ├── telegram-restart.sh
│   └── telegram-status.sh
├── memory/
│   ├── MEMORY.md
│   ├── agent-identity.md
│   └── generated-agents.md    ← Registry of all created agents
├── knowledge/
├── logs/
├── missions/                  ← todo/, in-progress/, done/, failed/, results/
└── sandbox/
```

---

## 4. Generator Engine (`tools/generate-agent.sh`)

### How It Works

1. **Parse config**: Reads a KEY=VALUE file (or interactive prompts)
2. **Validate**: Checks all 14 required variables are set
3. **Substitute**: Replaces `{{PLACEHOLDER}}` with values in all 16 templates
4. **Create directories**: missions/todo, in-progress, done, failed, results, knowledge, sandbox, logs
5. **Write files**: Generates all agent files with proper content
6. **Set permissions**: Makes scripts executable
7. **Install deps**: Runs `npm install` in the agent directory
8. **Report**: Shows summary and next steps

### Usage

```bash
# Interactive mode (prompts for all 13 values)
./tools/generate-agent.sh --interactive

# From config file
./tools/generate-agent.sh --config my-agent.env

# Dry run (preview only)
./tools/generate-agent.sh --config my-agent.env --dry-run
```

### Config File Format

Simple `KEY=VALUE` format. Values with spaces don't need quoting (parser handles them). Example:

```bash
AGENT_NAME=my-bot
AGENT_DISPLAY_NAME="My Bot"
AGENT_DIR=/srv/dev/agents/my-bot
PROJECT_DIR=/srv/dev/my-app
PROJECT_NAME=MyApp
PROJECT_DESCRIPTION=My awesome application
TELEGRAM_BOT_TOKEN=123456:ABCdef
TELEGRAM_CHAT_ID=123456789
ANTHROPIC_AUTH_TOKEN=sk-xxx
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
GITHUB_REPO=user/repo
PROD_URL=https://myapp.example.com
AGENT_USERNAME=@MyAppBot
AGENT_ROLE=AI dev agent for MyApp
```

---

## 5. Telegram Integration

### Agent Generator Bot: @AgentGenBot

**Token:** `8628309940:AAH8fNYeJeGRcASCZ852-E-7n98JcTDOoJI`

**Commands:**

| Command | Action |
|---------|--------|
| `/start` | Welcome + command list |
| `/generate --interactive` | 13-step interactive agent creation |
| `/generate --config <path>` | Generate from config file |
| `/list` | List all generated agents with status |
| `/status <name>` | Check specific agent status |
| `/mission <task>` | Full Claude CLI mission |
| `/externalllm <query>` | DeepSeek API call |
| Any text | Quick AI answer |

**Interactive generation flow:**
1. User sends `/generate --interactive`
2. Bot asks 13 questions one at a time
3. User answers each (or types `cancel`)
4. Defaults applied for AGENT_DIR, PROJECT_DIR, ANTHROPIC_BASE_URL
5. All values collected → writes config → runs generator → reports results

### How to Start

```bash
# Add aliases
source /srv/dev/agents/agent-generator/tools/aliases.sh

# Start the bot
tg-start

# Check status
tg-status
```

---

## 6. Key Design Decisions

1. **Template-based, not code-generation-based**: Templates are exact copies of the reference architecture with `{{PLACEHOLDER}}` substitution. This means any improvement to the reference architecture automatically applies to templates after a copy-update cycle.

2. **Self-hosting**: The agent-generator is itself an agent following the same architecture it generates. It uses the same telegram-server.js pattern, same scripts, same directory layout. This is intentional — the factory is a product of itself.

3. **Isolation per app**: Each generated agent has its own directory, .env, Telegram bot token, and project path. No shared state between agents. Each monitors one project.

4. **No hardcoded Moussawer values**: All project-specific values are parameterized. The templates are generic. The generator config provides the specifics.

5. **Generator installs dependencies**: `npm install` runs automatically after generation, so the agent is ready to start immediately.

6. **Manual config parser**: Uses `while IFS='=' read` instead of `source` to handle values with spaces safely.

---

## 7. Verification

### Dry Run Test
```
$ bash tools/generate-agent.sh --config .test-config.env --dry-run
Validating configuration...
  All 14 variables set.
Generating agent: TestBot
  Target: /srv/dev/agents/test-bot
  Project: /srv/dev/test-app
── DRY RUN — would generate these files: ──
  16 files listed
Dry run complete.
```

### Real Generation Test
```
$ bash tools/generate-agent.sh --config .test-config.env
Generating agent: TestBot
  ✓ CLAUDE.md
  ✓ .env
  ✓ package.json
  ✓ memory/MEMORY.md
  ✓ memory/agent-identity.md
  ✓ memory/incident-reports.md
  ✓ tools/aliases.sh
  ✓ tools/telegram-server.js
  ✓ tools/telegram-send.sh
  ✓ tools/telegram-heartbeat.sh
  ✓ tools/telegram-inbox.sh
  ✓ tools/telegram-poll.sh
  ✓ scripts/telegram-start.sh
  ✓ scripts/telegram-stop.sh
  ✓ scripts/telegram-restart.sh
  ✓ scripts/telegram-status.sh

Agent Generated Successfully!
  Files: 16 generated
  Unsubstituted placeholders: 0
```

### Template Verification
- 16 template files created
- All 14 placeholders properly substituted
- 0 remaining `{{...}}` patterns in generated output
- Scripts are executable
- npm dependencies installed
- Directory structure matches reference architecture

---

## 8. Post-Generation Checklist for Users

After generating an agent, the user should:

1. [ ] **Edit CLAUDE.md** — Fill in the project's actual tech stack in the "Tech Stack" section, add key file paths in "Key Files Map", and document critical warnings
2. [ ] **Verify .env** — Ensure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are correct (the token should be from @BotFather for the agent's own bot)
3. [ ] **Create the Telegram bot** — Use @BotFather to create a new bot with the token specified in .env
4. [ ] **Discover chat ID** — Send a message to the bot, then check `tg-inbox` or `tools/telegram-poll.sh` to discover the chat ID, update TELEGRAM_CHAT_ID in .env
5. [ ] **Start the server** — `cd AGENT_DIR && ./scripts/telegram-start.sh`
6. [ ] **Add aliases** — `source AGENT_DIR/tools/aliases.sh` (add to ~/.zshrc for persistence)
7. [ ] **Build project knowledge** — Populate `knowledge/` with API endpoints, database schema, deployment options, etc.
8. [ ] **Test** — Send `/start` to the bot via Telegram

---

## 9. Future Improvements

- [ ] **Agent update command**: `/update` to refresh an agent's CLAUDE.md or scripts from updated templates
- [ ] **Multi-agent coordination**: Allow agents to hand off tasks to each other
- [ ] **Web dashboard**: HTML page listing all agents, their status, recent missions
- [ ] **Template versioning**: Track which template version each agent was generated from
- [ ] **Health monitoring**: Proactive alerts if an agent's Telegram server dies
- [ ] **Agent backup/restore**: Archive and restore agent state
