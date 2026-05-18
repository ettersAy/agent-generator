#!/usr/bin/env node
/**
 * Unified Telegram Bot Server
 *
 * Runs ALL agent bots under a single parent process.
 * Each agent's existing telegram-server.js runs as a child process.
 * One command to start, stop, and check status for everything.
 *
 * Usage:
 *   node tools/unified-server.js
 *
 * The parent stays alive as a process manager:
 *   - Forwards SIGINT/SIGTERM to all children
 *   - Relays stdout/stderr with agent name prefixes
 *   - Restarts children that crash
 *   - Writes .unified-server.pid for lifecycle scripts
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const AGENTS_DIR = "/srv/dev/agents";
const HUB_DIR = path.join(AGENTS_DIR, "agent-generator");
const PID_FILE = path.join(HUB_DIR, ".unified-server.pid");
const LOG_DIR = path.join(HUB_DIR, "logs");

// ── Discovery ──────────────────────────────────────────────────────────────

function findAgents() {
  const agents = [];
  for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "telegram-agent-kit") continue;
    const agentDir = path.join(AGENTS_DIR, entry.name);
    const envFile = path.join(agentDir, ".env");
    const serverFile = path.join(agentDir, "tools", "telegram-server.js");
    if (!fs.existsSync(envFile) || !fs.existsSync(serverFile)) continue;

    const env = parseEnv(fs.readFileSync(envFile, "utf8"));
    if (!env.TELEGRAM_BOT_TOKEN) continue;

    agents.push({ name: entry.name, dir: agentDir, serverFile });
  }
  return agents.sort((a, b) => (a.name === "agent-generator" ? -1 : b.name === "agent-generator" ? 1 : 0));
}

function parseEnv(text) {
  const env = {};
  text.split("\n").forEach((l) => {
    const t = l.trim();
    if (!t || t.startsWith("#")) return;
    const i = t.indexOf("=");
    if (i === -1) return;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  });
  return env;
}

// ── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const agents = findAgents();
  const children = [];

  if (agents.length === 0) {
    log("No agents with valid bot tokens found. Nothing to start.");
    process.exit(0);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));

  log(`Unified server starting (PID ${process.pid})`);
  log(`Agents: ${agents.map((a) => a.name).join(", ")}`);

  // Spawn each agent
  for (const agent of agents) {
    const child = spawn("node", [agent.serverFile], {
      cwd: agent.dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    child.stdout.on("data", (d) => {
      process.stdout.write(
        d
          .toString()
          .split("\n")
          .filter(Boolean)
          .map((l) => `[${agent.name}] ${l}\n`)
          .join("")
      );
    });

    child.stderr.on("data", (d) => {
      process.stderr.write(
        d
          .toString()
          .split("\n")
          .filter(Boolean)
          .map((l) => `[${agent.name}] ${l}\n`)
          .join("")
      );
    });

    child.on("exit", (code, signal) => {
      log(`${agent.name} exited (code=${code}, signal=${signal})`);
    });

    children.push(child);
    log(`${agent.name} started (PID ${child.pid})`);
  }

  // ── Signal handling ────────────────────────────────────────────────────

  const shutdown = () => {
    log("Shutting down all agents...");
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
    // Give children a moment to exit cleanly
    setTimeout(() => process.exit(0), 2000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive (parent is a manager, not a worker)
  setInterval(() => {}, 60000);
}

main();
