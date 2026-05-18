// generation.js — Agent generation interactive session (extracted from telegram-server.js)
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const AGENT_DIR = "/srv/dev/agents/agent-generator";
const GENERATOR_SCRIPT = path.join(AGENT_DIR, "tools", "generate-agent.sh");

const STEPS = [
  { key: "AGENT_NAME", label: "Agent name (kebab-case)" },
  { key: "AGENT_DISPLAY_NAME", label: "Agent display name" },
  { key: "AGENT_DIR", label: "Agent directory", defaultPrefix: "/srv/dev/agents/" },
  { key: "PROJECT_DIR", label: "Project directory", defaultPrefix: "/srv/dev/" },
  { key: "PROJECT_NAME", label: "Project short name" },
  { key: "PROJECT_DESCRIPTION", label: "Project description (one line)" },
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token" },
  { key: "TELEGRAM_CHAT_ID", label: "Telegram chat ID" },
  { key: "ANTHROPIC_AUTH_TOKEN", label: "Anthropic/DeepSeek auth token" },
  { key: "ANTHROPIC_BASE_URL", label: "Anthropic base URL", default: "https://api.deepseek.com/anthropic" },
  { key: "GITHUB_REPO", label: "GitHub repo (owner/repo)" },
  { key: "AGENT_USERNAME", label: "Telegram bot username (e.g. @MyBot)" },
  { key: "AGENT_ROLE", label: "Agent role description (one line)" },
];

function createSession() {
  return { step: 0, data: {} };
}

function acceptInput(session, text) {
  const step = STEPS[session.step];
  session.data[step.key] = text;

  // Auto-fix common path fields
  if (step.key === "AGENT_DIR" && session.data.AGENT_NAME) {
    const d = session.data.AGENT_DIR;
    if (!d.startsWith("/")) session.data.AGENT_DIR = `/srv/dev/agents/${d}`;
  }
  if (step.key === "PROJECT_DIR" && session.data.AGENT_NAME) {
    const d = session.data.PROJECT_DIR;
    if (!d.startsWith("/")) session.data.PROJECT_DIR = `/srv/dev/${d}`;
  }
  if (step.key === "ANTHROPIC_BASE_URL" && (!text || text === "-")) {
    session.data.ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
  }

  session.step++;

  if (session.step >= STEPS.length) {
    return { done: true, session };
  }

  const next = STEPS[session.step];
  let prompt = `<b>Step ${session.step + 1}/13: ${next.label}</b>`;
  if (next.default) prompt += `\n(default: ${next.default}, type <code>-</code> to accept)`;
  prompt += `\n\nType <code>cancel</code> to abort.`;

  return { done: false, prompt, session };
}

function finalize(session) {
  const configPath = path.join(AGENT_DIR, ".last-gen-config.env");
  const lines = STEPS.map((s) => `${s.key}=${session.data[s.key] || ""}`);
  fs.writeFileSync(configPath, lines.join("\n"));

  const result = execSync(`bash "${GENERATOR_SCRIPT}" --config "${configPath}"`, {
    cwd: AGENT_DIR,
    encoding: "utf8",
    timeout: 60000,
  });

  return { configPath, result };
}

module.exports = { createSession, acceptInput, finalize, STEPS };
