#!/usr/bin/env node
/**
 * Inter-Agent Bridge — Background daemon that polls the agent's inter-agent
 * inbox and processes incoming messages from other agents.
 *
 * Lifecycle: Started by telegram-server.js, runs as a setInterval loop.
 * Writes PID to .agent-bridge.pid for cleanup.
 *
 * Message types handled:
 *   - config-request: Auto-respond with sanitized deployment config
 *   - question: Spawn lightweight Claude to answer, then respond
 *   - response: Log and send Telegram notification
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const https = require("https");
const crypto = require("crypto");

const AGENT_DIR = process.env.AGENT_DIR || process.argv[2];
if (!AGENT_DIR) {
  console.error("Usage: node agent-bridge.js <agent-dir>");
  process.exit(1);
}

const AGENT_NAME = path.basename(AGENT_DIR);
const SHARED_DIR = "/srv/dev/agents/_shared";
const REGISTRY_FILE = path.join(SHARED_DIR, "registry.txt");
const INBOX_DIR = path.join(SHARED_DIR, "mailbox", AGENT_NAME, "inbox");
const PID_FILE = path.join(AGENT_DIR, ".agent-bridge.pid");
const LOG_FILE = path.join(AGENT_DIR, "logs", "agent-bridge.log");
const PROCESSED_FILE = path.join(AGENT_DIR, ".agent-bridge-processed.json");
const INCIDENT_DIR = path.join(SHARED_DIR, "incidents");
const ERROR_LIMIT = 5; // consecutive errors before triggering incident

// ── Helpers ──────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }
function fmtTs() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

function log(msg) {
  const line = `[${fmtTs()}] ${msg}`;
  console.log(line);
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function logError(msg) {
  const line = `[${fmtTs()}] ERROR ${msg}`;
  console.error(line);
  const errLogFile = path.join(AGENT_DIR, "logs", "errors.log");
  try {
    const dir = path.dirname(errLogFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(errLogFile, line + "\n");
  } catch {}
}

function fileIncident(type, detail) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const incident = {
    id,
    type,
    agent: AGENT_NAME,
    timestamp: ts(),
    detail: detail.slice(0, 500),
    status: "open",
  };
  try {
    if (!fs.existsSync(INCIDENT_DIR)) fs.mkdirSync(INCIDENT_DIR, { recursive: true });
    const filename = `${ts().replace(/:/g, "_")}-${AGENT_NAME}-${id}.json`;
    fs.writeFileSync(path.join(INCIDENT_DIR, filename), JSON.stringify(incident, null, 2));
    log(`Incident filed: ${id} (${type})`);
  } catch (e) {
    log(`Failed to file incident: ${e.message}`);
  }
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  fs.readFileSync(filePath, "utf8").split("\n").forEach((l) => {
    const t = l.trim();
    if (!t || t.startsWith("#")) return;
    const i = t.indexOf("=");
    if (i === -1) return;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  });
  return env;
}

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) return {};
  const reg = {};
  fs.readFileSync(REGISTRY_FILE, "utf8").split("\n").forEach((l) => {
    const t = l.trim();
    if (!t || t.startsWith("#")) return;
    const parts = t.split(/\s+/);
    if (parts.length >= 3) {
      reg[parts[0]] = { username: parts[1], dir: parts[2] };
    }
  });
  return reg;
}

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8")));
    }
  } catch {}
  return new Set();
}

function saveProcessed(set) {
  // Keep only last 500 IDs to avoid unbounded growth
  const arr = Array.from(set).slice(-500);
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr));
}

function sendTelegram(env, message) {
  return new Promise((resolve) => {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      log("No Telegram creds, skipping notification");
      return resolve(false);
    }
    const body = JSON.stringify({
      chat_id: chatId,
      text: message.slice(0, 3900),
      parse_mode: "HTML",
    });
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${token}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => resolve(true));
    });
    req.on("error", () => resolve(false));
    req.write(body);
    req.end();
  });
}

function maskToken(s) {
  if (!s) return "(not set)";
  if (s.length <= 8) return "***";
  return s.slice(0, 4) + "..." + s.slice(-4);
}

// ── Incident Reporting ────────────────────────────────────────────────────

function fileIncident(type, detail) {
  const id = `${ts().replace(/:/g, "_")}-${AGENT_NAME}-${crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Date.now().toString(36)}`;
  const incident = {
    id,
    type,
    agent: AGENT_NAME,
    timestamp: ts(),
    detail,
    status: "open",
  };
  try {
    fs.mkdirSync(INCIDENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(INCIDENT_DIR, `${id}.json`), JSON.stringify(incident, null, 2));
    log(`Incident filed: ${type} → ${id}`);
  } catch (e) {
    log(`ERROR: Could not file incident: ${e.message}`);
  }
  return id;
}

// ── Config Auto-Response ─────────────────────────────────────────────────

function buildConfigResponse() {
  const env = loadEnv(path.join(AGENT_DIR, ".env"));
  const claudePath = path.join(AGENT_DIR, "CLAUDE.md");

  // Extract deployment section from CLAUDE.md
  let deploymentSection = "";
  try {
    const claude = fs.readFileSync(claudePath, "utf8");
    const deployMatch = claude.match(/## Deployment[\s\S]*?(?=## |\n## |\Z)/i);
    if (deployMatch) deploymentSection = deployMatch[0].trim();
  } catch {}

  // Determine agent capabilities from env vars
  const secretPattern = /TOKEN|SECRET|KEY|AUTH|HOOK/i;
  const envKeys = Object.keys(env).filter((k) => !secretPattern.test(k));
  const secretKeys = Object.keys(env).filter((k) => secretPattern.test(k));

  let response = `=== ${AGENT_NAME} Deployment Configuration ===\n\n`;

  response += `## Environment Variables (non-secret)\n`;
  for (const k of envKeys.sort()) {
    response += `  ${k}=${env[k]}\n`;
  }

  response += `\n## Secrets (masked) — which keys are configured\n`;
  for (const k of secretKeys.sort()) {
    response += `  ${k}=${maskToken(env[k])}\n`;
  }

  if (deploymentSection) {
    response += `\n## Deployment Guide (from CLAUDE.md)\n${deploymentSection}\n`;
  }

  response += `\n---\nShared by ${AGENT_NAME} via inter-agent bridge at ${ts()}`;
  return response;
}

// ── Ask Claude ───────────────────────────────────────────────────────────

function askClaude(question, fromAgent) {
  return new Promise((resolve) => {
    const prompt = `You are ${AGENT_NAME}, an AI dev agent. Another agent (${fromAgent}) sent you this question. Answer concisely and helpfully. If the question is about deployment, infrastructure, or configuration, be specific about what you use and how it's set up.

QUESTION FROM ${fromAgent}:
${question}

Respond in plain text. Under 2000 characters.`;

    // Load .env to pass auth vars to Claude CLI
    const agentEnv = loadEnv(path.join(AGENT_DIR, ".env"));
    const execEnv = { ...process.env };
    if (agentEnv.ANTHROPIC_AUTH_TOKEN) {
      execEnv.ANTHROPIC_AUTH_TOKEN = execEnv.ANTHROPIC_AUTH_TOKEN || agentEnv.ANTHROPIC_AUTH_TOKEN;
      execEnv.ANTHROPIC_BASE_URL = execEnv.ANTHROPIC_BASE_URL || agentEnv.ANTHROPIC_BASE_URL;
    }
    if (agentEnv.CLAUDE_MAX_BUDGET) execEnv.CLAUDE_MAX_BUDGET = agentEnv.CLAUDE_MAX_BUDGET;

    try {
      const result = execSync(
        `claude -p --max-turns 3 --output-format text --dangerously-skip-permissions -`,
        { input: prompt, encoding: "utf8", timeout: 120000, cwd: AGENT_DIR, maxBuffer: 10 * 1024 * 1024, env: execEnv }
      );
      resolve(result.slice(0, 3000));
    } catch (e) {
      log(`WARN: Claude (max-turns 3) failed: ${e.message.slice(0, 150)}. Retrying with max-turns 2...`);
      try {
        const result = execSync(
          `claude -p --max-turns 2 --output-format text --dangerously-skip-permissions -`,
          { input: prompt.slice(0, 2000), encoding: "utf8", timeout: 90000, cwd: AGENT_DIR, maxBuffer: 5 * 1024 * 1024, env: execEnv }
        );
        resolve(result.slice(0, 3000));
      } catch (e2) {
        log(`ERROR: Claude fallback also failed: ${e2.message.slice(0, 150)}`);
        logError(`Claude spawn failed twice for question from ${fromAgent}: ${e2.message.slice(0, 200)}`);
        fileIncident("claude_spawn_failed", `Claude CLI failed for question from ${fromAgent}: ${e2.message.slice(0, 200)}`);
        resolve(`[${AGENT_NAME} could not process this question: ${e2.message.slice(0, 200)}]`);
      }
    }
  });
}

// ── Respond helper ───────────────────────────────────────────────────────

function writeResponse(toAgent, replyToId, body) {
  const registry = loadRegistry();
  const target = registry[toAgent];
  if (!target) {
    log(`ERROR: Cannot respond - agent "${toAgent}" not in registry`);
    return false;
  }

  const targetInbox = path.join(SHARED_DIR, "mailbox", toAgent, "inbox");
  if (!fs.existsSync(targetInbox)) fs.mkdirSync(targetInbox, { recursive: true });

  const now = ts().replace(/:/g, "_");
  const respId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const filename = `${now}-${AGENT_NAME}-${respId}.json`;

  const msg = {
    id: respId,
    from: AGENT_NAME,
    to: toAgent,
    timestamp: new Date().toISOString(),
    type: "response",
    subject: `Re: ${replyToId ? replyToId.slice(0, 40) : "request"}`,
    body: body,
    reply_to: replyToId || null,
  };

  fs.writeFileSync(path.join(targetInbox, filename), JSON.stringify(msg, null, 2));
  log(`Response sent to ${toAgent}: ${filename}`);
  return true;
}

// ── Process a message ────────────────────────────────────────────────────

async function processMessage(filePath, env) {
  let msg;
  try {
    msg = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    log(`WARN: Could not parse ${path.basename(filePath)}`);
    return;
  }

  // Skip own messages (shouldn't happen, but guard)
  if (msg.from === AGENT_NAME) return;

  log(`Processing: ${msg.type} from ${msg.from} (id: ${msg.id})`);

  switch (msg.type) {
    case "config-request":
      log("Auto-responding with deployment config...");
      const config = buildConfigResponse();
      writeResponse(msg.from, msg.id, config);

      // Notify shared chat
      const registry = loadRegistry();
      const fromInfo = registry[msg.from] || { username: `@${msg.from}` };
      const myInfo = registry[AGENT_NAME] || { username: `@${AGENT_NAME}` };
      await sendTelegram(env,
        `${myInfo.username} shared deployment config with ${fromInfo.username}.\n\n` +
        `<pre>${config.slice(0, 500)}</pre>\n\n` +
        `Full config (${config.length} chars) delivered to inbox.`
      );
      break;

    case "question":
      log(`Asking Claude to answer: "${msg.subject}"...`);
      await sendTelegram(env,
        `${loadRegistry()[AGENT_NAME]?.username || `@${AGENT_NAME}`} received a question from ` +
        `${loadRegistry()[msg.from]?.username || `@${msg.from}`}: "${msg.subject}"\n` +
        `Thinking...`
      );

      const answer = await askClaude(msg.body, msg.from);
      writeResponse(msg.from, msg.id, answer);

      await sendTelegram(env,
        `${loadRegistry()[AGENT_NAME]?.username || `@${AGENT_NAME}`} answered ` +
        `${loadRegistry()[msg.from]?.username || `@${msg.from}`}:\n\n` +
        `${answer.slice(0, 1500)}`
      );
      break;

    case "response":
      log(`Response from ${msg.from} (reply to ${msg.reply_to || "?"}): ${msg.body.slice(0, 100)}...`);
      const respReg = loadRegistry();
      const respFrom = respReg[msg.from] || { username: `@${msg.from}` };
      await sendTelegram(env,
        `${respFrom.username} responded:\n\n${msg.body.slice(0, 3500)}`
      );
      break;

    case "incident":
      log(`Incident report from ${msg.from}: ${msg.subject}`);
      // Also file to shared incident directory
      fileIncident("agent_reported", `From ${msg.from}: ${msg.body.slice(0, 500)}`);
      const incReg = loadRegistry();
      const incFrom = incReg[msg.from] || { username: `@${msg.from}` };
      await sendTelegram(env,
        `🚨 <b>Incident from ${incFrom.username}</b>\n\n${msg.body.slice(0, 1500)}`
      );
      break;

    default:
      log(`Unknown message type: ${msg.type}`);
  }
}

// ── Main loop ────────────────────────────────────────────────────────────

let processed = loadProcessed();
let running = true;
let polling = false;    // guards against concurrent poll() via setInterval
let errors = 0;         // consecutive error counter for incident reporting

async function poll() {
  // —— Guard: prevent concurrent polls (root cause of duplicate messages) ——
  if (polling) return;
  polling = true;

  try {
    if (!fs.existsSync(INBOX_DIR)) {
      fs.mkdirSync(INBOX_DIR, { recursive: true });
      return;
    }

    const files = fs.readdirSync(INBOX_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort(); // oldest first

    const env = loadEnv(path.join(AGENT_DIR, ".env"));

    for (const file of files) {
      if (processed.has(file)) continue;

      const filePath = path.join(INBOX_DIR, file);
      log(`New message: ${file}`);

      try {
        await processMessage(filePath, env);
        processed.add(file);
        saveProcessed(processed);
        errors = 0; // reset on success
      } catch (e) {
        log(`ERROR processing ${file}: ${e.message}`);
        processed.add(file);
        saveProcessed(processed);
        errors++;
        if (errors >= ERROR_LIMIT) {
          fileIncident("bridge_error_loop", `Bridge hit ${errors} consecutive errors. Last: ${e.message.slice(0, 200)}`);
        }
      }
    }
  } finally {
    polling = false; // always release lock
  }
}

// —— PID guard: check no other bridge is already running for this agent ——
function checkExisting() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim());
      try {
        process.kill(oldPid, 0); // signal 0 = existence check
        log(`Another bridge instance (PID ${oldPid}) is already running. Exiting.`);
        process.exit(0);
      } catch {
        // PID file is stale — the process is dead. Remove it.
        log(`Stale PID file (${oldPid} not alive), cleaning up`);
        fs.unlinkSync(PID_FILE);
      }
    }
  } catch {}
}
checkExisting();

log(`Bridge starting for ${AGENT_NAME} — inbox: ${INBOX_DIR}`);
fs.writeFileSync(PID_FILE, String(process.pid));

// Initial poll, then every 5 seconds (poll lock prevents overlap)
poll().then(() => {
  const interval = setInterval(poll, 5000);

  process.on("SIGINT", () => { running = false; clearInterval(interval); cleanup(); });
  process.on("SIGTERM", () => { running = false; clearInterval(interval); cleanup(); });
});

function cleanup() {
  log("Bridge shutting down");
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

// Safety: if parent (telegram-server) dies, exit
process.on("SIGHUP", () => { cleanup(); });
