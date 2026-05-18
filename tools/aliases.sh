# Agent Generator Shell Aliases
# Source this file to get shortcuts for managing the Telegram server and dispatcher.
# Add to your ~/.zshrc: source /srv/dev/agents/agent-generator/tools/aliases.sh

alias tg-start='/srv/dev/agents/agent-generator/scripts/telegram-start.sh'
alias tg-stop='/srv/dev/agents/agent-generator/scripts/telegram-stop.sh'
alias tg-restart='/srv/dev/agents/agent-generator/scripts/telegram-restart.sh'
alias tg-status='/srv/dev/agents/agent-generator/scripts/telegram-status.sh'
alias tg-log='tail -f /srv/dev/agents/agent-generator/logs/unified-server.log'
alias tg-inbox='/srv/dev/agents/agent-generator/tools/telegram-inbox.sh'
alias tg-errors='tail -f /srv/dev/agents/agent-generator/logs/errors.log'
alias tg-update='bash /srv/dev/agents/agent-generator/tools/telegram-heartbeat.sh'
alias mission-summary='/srv/dev/agents/agent-generator/tools/mission-summary.sh'

# Dispatcher
alias dispatch-log='tail -f /srv/dev/agents/agent-generator/logs/dispatcher.log'
alias dispatch-start='AGENT_DIR=/srv/dev/agents/agent-generator nohup bash /srv/dev/agents/agent-generator/scripts/mission-dispatcher.sh >> /srv/dev/agents/agent-generator/logs/dispatcher.log 2>&1 &'
alias dispatch-stop='test -f /srv/dev/agents/agent-generator/.mission-dispatcher.pid && kill $(cat /srv/dev/agents/agent-generator/.mission-dispatcher.pid) 2>/dev/null; rm -f /srv/dev/agents/agent-generator/.mission-dispatcher.pid; echo "Dispatcher stopped"'

# Mission queue
alias mq='echo "TODO:"; ls /srv/dev/agents/agent-generator/missions/todo/*.md 2>/dev/null | tail -10 || echo "  (empty)"; echo "IN-PROGRESS:"; ls /srv/dev/agents/agent-generator/missions/in-progress/*.md 2>/dev/null | tail -5 || echo "  (empty)"; echo "DONE (last 5):"; ls /srv/dev/agents/agent-generator/missions/done/*.md 2>/dev/null | tail -5 || echo "  (empty)"; echo "FAILED (last 5):"; ls /srv/dev/agents/agent-generator/missions/failed/*.md 2>/dev/null | tail -5 || echo "  (empty)"'
