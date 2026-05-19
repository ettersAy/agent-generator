# Q&A / Troubleshooting

## Common Issues

### Q: The Telegram bot isn't responding

**Check if services are running:**
```bash
tg-status
```

**If offline, start them:**
```bash
tg-start
```

**Check logs for errors:**
```bash
tg-log      # Server logs
tg-errors   # Error logs
```

**Common causes:**
- `.env` file missing or has wrong token
- Network/API connectivity issue
- Another instance already running (check PID files)

### Q: Missions are stuck in "todo" and never execute

**Check the dispatcher:**
```bash
tg-status          # See if dispatcher is running
dispatch-log       # Check dispatcher logs
```

**If dispatcher is down:**
```bash
dispatch-start     # Start dispatcher independently
```

**Common causes:**
- MAX_CONCURRENT reached (2 missions already running)
- Dispatcher crashed — check logs
- File permissions issue in missions/ directory

### Q: A mission has been running for hours

**Check if the runner process is still alive:**
```bash
ls missions/in-progress/*.pid
cat missions/in-progress/<mission-id>.pid   # Get PID
ps -p <PID>                                  # Check if alive
```

**If the runner is dead but mission file remains:**
```bash
# Move to failed manually:
mv missions/in-progress/<file> missions/failed/
rm missions/in-progress/<file>.pid
```

The dispatcher will also auto-recover on restart (4-hour timeout).

### Q: The web dashboard shows "offline" but services are running

The dashboard checks PID files. If a PID file is stale:
```bash
# Check actual processes:
ps aux | grep unified-server
ps aux | grep mission-dispatcher

# Remove stale PID files:
rm .unified-server.pid
rm .mission-dispatcher.pid

# Restart services:
tg-restart
```

### Q: How do I add a new agent template?

Edit files in `templates/` directory. Use `{{PLACEHOLDER}}` syntax. Available placeholders are listed in `CLAUDE.md`.

### Q: How do I change the web dashboard port?

```bash
bash scripts/web-dashboard-start.sh 8080   # Use port 8080
```

Or directly:
```bash
node tools/web-dashboard.js 8080
```

### Q: How do I view old mission results?

```bash
# List recent missions:
mission-summary -n 10

# Read a specific result:
cat missions/results/<mission-id>_result.md

# Or use the web dashboard:
# Click on any mission in the Done/Failed cards
```

### Q: How do I cancel a queued mission?

Via Telegram:
```
/cancel <mission-id>
```

Via filesystem:
```bash
mv missions/todo/<file> missions/failed/
```

### Q: The generation interactive mode hangs

Interactive generation requires the unified server to maintain session state. If it hangs:
1. Check server logs: `tg-log`
2. Restart the server: `tg-restart`
3. Try again with a fresh `/generate --interactive`

### Q: Where are logs stored?

| Log | Path |
|-----|------|
| Server | `logs/unified-server.log` |
| Dispatcher | `logs/dispatcher.log` |
| Web Dashboard | `logs/web-dashboard.log` |
| Errors | `logs/errors.log` |

### Q: How do I back up the system?

```bash
# The important data is in:
# - missions/ (all mission files and results)
# - memory/ (persistent knowledge)
# - docs/ (documentation)
# - .env (configuration)

tar -czf backup-$(date +%Y%m%d).tar.gz missions/ memory/ docs/ .env
```
