// agents.js — Agent discovery and status (shared by server + dashboard)
const fs = require("fs");
const path = require("path");

const AGENTS_DIR = "/srv/dev/agents";

function listAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        fs.existsSync(path.join(AGENTS_DIR, d.name, ".env")) &&
        d.name !== "telegram-agent-kit"
    )
    .map((d) => {
      const agentPath = path.join(AGENTS_DIR, d.name);
      const claudeMd = path.join(agentPath, "CLAUDE.md");
      const pidFile = path.join(agentPath, ".telegram-server.pid");
      const inboxFile = path.join(agentPath, "logs", "messages.jsonl");

      let desc = "(no CLAUDE.md)";
      let running = false;
      let pid = null;

      if (fs.existsSync(claudeMd)) {
        try {
          const content = fs.readFileSync(claudeMd, "utf8");
          const match = content.match(/^# CLAUDE\.md — (.+)$/m);
          if (match) desc = match[1];
        } catch {}
      }

      if (fs.existsSync(pidFile)) {
        try {
          pid = parseInt(fs.readFileSync(pidFile, "utf8"));
          process.kill(pid, 0);
          running = true;
        } catch {}
      }

      let messageCount = 0;
      if (fs.existsSync(inboxFile)) {
        try {
          messageCount = fs
            .readFileSync(inboxFile, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean).length;
        } catch {}
      }

      return { name: d.name, path: agentPath, description: desc, running, pid, messageCount };
    });
}

function getAgentDetail(agentName) {
  return listAgents().find((a) => a.name === agentName) || null;
}

module.exports = { listAgents, getAgentDetail, AGENTS_DIR };
