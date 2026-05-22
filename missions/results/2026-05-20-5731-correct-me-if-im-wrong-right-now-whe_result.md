## Accomplished

Implemented two new Telegram trigger commands for mission execution:

1. **`/NewMission`** — Queues a mission that starts a **fresh Claude session** (`claude -p`). This is equivalent to what `/mission` used to do.

2. **`/mission`** — Changed to queue a mission that **continues the last Claude session** (`claude -c -p`). The `-c` flag tells Claude CLI to resume the previous conversation.

Both commands use the v2 queue-based architecture (mission file → dispatcher → runner → result).

## Files Changed

- **`tools/telegram-server.js`** — Added `^/NewMission\b` and `^/mission\b` custom commands that queue missions with `Mode: new` or `Mode: continue` metadata; updated start message and queue empty message
- **`tools/mission-runner.sh`** — Added Mode detection from mission file metadata; runs `claude -c -p` for continue mode or `claude -p` for new/fresh mode
- **`CLAUDE.md`** — Updated commands table to document both triggers

## Verification

- Both files pass syntax checks (`node --check`, `bash -n`)
- `/NewMission <task>` → creates mission file with `| **Mode** | new |` → runner uses `claude -p`
- `/mission <task>` → creates mission file with `| **Mode** | continue |` → runner uses `claude -c -p`
- Legacy missions (no Mode field) default to `claude -p` (fresh session)
- Custom command patterns intercepted before base class standard handlers — no double-processing

## Issues

None
