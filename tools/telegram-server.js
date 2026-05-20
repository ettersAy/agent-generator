#!/usr/bin/env node
/**
 * Agent Generator Telegram Bot Server
 *
 * Commands: /generate, /list, /status, /mission, /queue, /cancel, /ask, /status-all
 * Inter-agent bridge via beforePoll/afterStop hooks.
 */

const fs = require("fs");
const path = require("path");
const { AgentServer } = require("/srv/dev/agents/telegram-agent-kit");
const { startBridge, stopBridge, isBridgeRunning } = require("/srv/dev/agents/telegram-agent-kit/bridge");
const { listAgents } = require("./lib/agents");
const { getQueueSnapshot, getDispatcherStatus } = require("./lib/queue");
const { createSession, acceptInput, finalize } = require("./lib/generation");

const AGENT_DIR = "/srv/dev/agents/agent-generator";

// ── Generation sessions ────────────────────────────────────────────────────
const genSessions = {};

async function handleGenerateCmd(tg, store, chatId, args, updateId) {
  const subCmd = args.trim();

  if (subCmd === "--interactive" || subCmd === "-i") {
    genSessions[chatId] = createSession();
    await tg.sendMessage(
      chatId,
      `<b>Agent Generator — Interactive Mode</b>\n\n` +
        `I'll ask you for each config value. Type <code>cancel</code> to abort.\n\n` +
        `<b>Step 1/13: Agent name</b> (kebab-case, e.g. <code>my-app-bot</code>):`
    );
    store.markReplied(updateId);
    return;
  }

  if (subCmd.startsWith("--config")) {
    const configPath = subCmd.slice(8).trim();
    if (!configPath) {
      await tg.sendMessage(chatId, "Usage: <b>/generate --config &lt;file&gt;</b>");
      store.markReplied(updateId);
      return;
    }
    await tg.sendMessage(chatId, `Generating agent from config: ${configPath}...`);
    try {
      const result = require("child_process").execSync(
        `bash "${path.join(AGENT_DIR, "tools", "generate-agent.sh")}" --config "${configPath}"`,
        { cwd: AGENT_DIR, encoding: "utf8", timeout: 30000 }
      );
      await tg.sendMessage(chatId, `<b>Done!</b>\n<pre>${result.slice(0, 3500)}</pre>`);
    } catch (e) {
      await tg.sendMessage(chatId, `Generation failed: ${e.message}`);
    }
    store.markReplied(updateId);
    return;
  }

  await tg.sendMessage(chatId, "Usage:\n<b>/generate --interactive</b>\n<b>/generate --config &lt;file&gt;</b>");
  store.markReplied(updateId);
}

async function continueGenSession(tg, store, chatId, text, updateId) {
  const session = genSessions[chatId];
  if (!session) return false;

  if (text.toLowerCase() === "cancel") {
    delete genSessions[chatId];
    await tg.sendMessage(chatId, "Generation cancelled.");
    store.markReplied(updateId);
    return true;
  }

  const result = acceptInput(session, text);
  if (result.done) {
    await tg.sendMessage(chatId, "All values collected. Running generator...");
    try {
      const { configPath, result: genResult } = finalize(session);
      await tg.sendMessage(chatId, `<b>Agent Generated!</b>\n<pre>${genResult.slice(0, 3500)}</pre>\nConfig: ${configPath}`);
    } catch (e) {
      await tg.sendMessage(chatId, `Generation failed: ${e.message}`);
    }
    delete genSessions[chatId];
    store.markReplied(updateId);
    return true;
  }

  await tg.sendMessage(chatId, result.prompt);
  store.markReplied(updateId);
  return true;
}

// ── /ask handler ──────────────────────────────────────────────────────────
async function handleAskCmd(tg, store, chatId, args, updateId) {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0]) {
    await tg.sendMessage(chatId,
      "Usage: <b>/ask &lt;agent&gt; &lt;question&gt;</b>\n" +
      "  <b>/ask &lt;agent&gt; --config</b> — request deployment config\n" +
      "Agents: mouss-ai, tamarine-bot, agent-generator"
    );
    store.markReplied(updateId);
    return;
  }

  const target = parts[0];
  let msgType = "question";
  let message;

  if (parts[1] === "--config") {
    msgType = "config-request";
    message = parts.slice(2).join(" ") || "Share your deployment configuration";
  } else {
    message = parts.slice(1).join(" ");
  }

  try {
    const result = require("child_process").execSync(
      `bash "${path.join(AGENT_DIR, "tools", "agent-ask.sh")}" --type ${msgType} "${target}" "${message.replace(/"/g, '\\"')}"`,
      { cwd: AGENT_DIR, encoding: "utf8", timeout: 15000 }
    );
    const uuid = result.trim().split("\n").pop() || "";
    await tg.sendMessage(chatId,
      `<b>Message sent</b> to ${target}\n` +
      `Type: ${msgType}\n` +
      `ID: <code>${uuid.slice(-20)}</code>\n` +
      `<i>The target agent's bridge will pick it up.</i>`
    );
  } catch (e) {
    await tg.sendMessage(chatId, `Ask failed: ${e.message.slice(0, 200)}`);
  }
  store.markReplied(updateId);
}

// ── Custom commands ────────────────────────────────────────────────────────
const customCommands = {
  "^/list$": async function (chatId, _args, updateId) {
    const agents = listAgents();
    if (agents.length === 0) {
      await this.tg.sendMessage(chatId, "No agents generated yet.");
    } else {
      const lines = agents.map((a) => `• <b>${a.name}</b> ${a.running ? "🟢" : "⚫"} — ${a.description}`);
      await this.tg.sendMessage(chatId, `<b>Agents (${agents.length})</b>\n\n${lines.join("\n")}`);
    }
  },

  "^/status\\s+": async function (chatId, args, updateId) {
    const agentName = args.trim();
    if (!agentName) { await this.tg.sendMessage(chatId, "Usage: <b>/status &lt;agent-name&gt;</b>"); return; }
    const agents = listAgents();
    const a = agents.find((x) => x.name === agentName);
    if (!a) { await this.tg.sendMessage(chatId, `Agent <b>${agentName}</b> not found.`); return; }
    await this.tg.sendMessage(chatId,
      `<b>${a.name}</b>\nDescription: ${a.description}\nStatus: ${a.running ? `Running (PID ${a.pid})` : "Not running"}\nPath: ${a.path}`
    );
  },

  "^/generate": async function (chatId, args, updateId) {
    await handleGenerateCmd(this.tg, this.store, chatId, args, updateId);
  },

  "^/ask\\s+": async function (chatId, args, updateId) {
    await handleAskCmd(this.tg, this.store, chatId, args, updateId);
  },

  "^/queue$": async function (chatId, _args, updateId) {
    const q = getQueueSnapshot();
    const labels = { todo: "⏳ Queued", inProgress: "🔄 Running", done: "✅ Done", failed: "❌ Failed" };
    const sections = [];
    for (const key of ["inProgress", "todo", "done", "failed"]) {
      const items = q[key];
      if (items.length === 0) continue;
      const show = key === "todo" || key === "inProgress" ? items : items.slice(-3);
      let section = `<b>${labels[key]} (${items.length})</b>\n`;
      for (const item of show) {
        section += `  • <code>${item.id.slice(-30)}</code> — ${item.title.slice(0, 50)}${item.runnerAlive ? " [runner alive]" : ""}\n`;
      }
      if (key === "done" && items.length > 3) section += `  ... and ${items.length - 3} more\n`;
      sections.push(section);
    }
    await this.tg.sendMessage(chatId,
      sections.length === 0 ? "<b>Mission Queue</b>\n\nEmpty. Send <b>/mission &lt;task&gt;</b>." : `<b>Mission Queue</b>\n\n${sections.join("\n")}`
    );
  },

  "^/cancel\\s+": async function (chatId, args, updateId) {
    const searchId = args.trim();
    if (!searchId) { await this.tg.sendMessage(chatId, "Usage: <b>/cancel &lt;id-fragment&gt;</b>"); return; }
    const todoDir = path.join(AGENT_DIR, "missions", "todo");
    if (!fs.existsSync(todoDir)) { await this.tg.sendMessage(chatId, "No pending missions."); return; }
    const files = fs.readdirSync(todoDir).filter((f) => f.endsWith(".md"));
    const match = files.find((f) => f.includes(searchId));
    if (!match) { await this.tg.sendMessage(chatId, `No pending mission matching "${searchId}".`); return; }
    fs.unlinkSync(path.join(todoDir, match));
    await this.tg.sendMessage(chatId, `Cancelled: <b>${match.replace(".md", "")}</b>`);
  },

  _continueGenSession: async function (chatId, text, updateId) {
    await continueGenSession(this.tg, this.store, chatId, text, updateId);
  },
};

// ── Start message ─────────────────────────────────────────────────────────
const startMessage = function (chatId, updateId) {
  return this.tg.sendMessage(chatId,
    `<b>Agent Generator</b> — AI Agent Factory\n\n` +
      `<b>Commands:</b>\n` +
      `• <b>/generate --interactive</b> — Create AI agent step-by-step\n` +
      `• <b>/generate --config &lt;file&gt;</b> — Generate from config\n` +
      `• <b>/list</b> — List all agents\n` +
      `• <b>/status &lt;name&gt;</b> — Agent status\n` +
      `• <b>/ask &lt;agent&gt; &lt;question&gt;</b> — Ask another agent\n` +
      `• <b>/mission &lt;task&gt;</b> — Queue mission\n` +
      `• <b>/queue</b> — View mission queue\n` +
      `• <b>/cancel &lt;id&gt;</b> — Cancel pending\n` +
      `• <b>Any text</b> — Quick AI answer\n\n` +
      `<i>Missions execute independently — no time limits.</i>`
  ).then(() => this.store.markReplied(updateId));
};

// ── Server ─────────────────────────────────────────────────────────────────
const server = new AgentServer(AGENT_DIR, {
  agentDisplayName: "Agent Generator",
  projectName: "Agent Factory",
  roleDescription: "AI Agent Factory — creates and manages AI dev agents",
  customCommands,
});

// Queue-based handleMission (v2)
server.handleMission = async function (chatId, taskText, updateId) {
  const missionFile = this.missions.create(taskText);
  const basename = path.basename(missionFile);
  this.log(`Mission queued: ${basename}`);

  let queuePos = 0;
  try {
    if (fs.existsSync(this.config.M_TODO)) {
      queuePos = fs.readdirSync(this.config.M_TODO).filter((f) => f.endsWith(".md")).length;
    }
  } catch {}

  await this.tg.sendMessage(chatId,
    `<b>Mission queued</b>\n` +
      `<pre>${taskText.slice(0, 120)}</pre>\n` +
      `ID: <code>${basename.replace(".md", "")}</code>\n` +
      `Queue position: ${queuePos}\n` +
      `<i>Runs independently — no time limits.</i>`
  );
  this.store.markReplied(updateId);
};

// Process update override (intercept /start + gen sessions)
const origProcessUpdate = server.processUpdate.bind(server);
server.processUpdate = async function (update) {
  const msg = update.message;
  if (!msg) return origProcessUpdate(update);
  const text = msg.text || "";
  const cleanText = text.replace(/^\/btw\b\s*/i, "").trim();

  if (/^\/start$/i.test(cleanText)) {
    const chatId = msg.chat?.id;
    if (chatId) await startMessage.call(this, chatId, update.update_id);
    return;
  }

  if (genSessions[msg.chat?.id]) {
    await continueGenSession(this.tg, this.store, msg.chat.id, cleanText, update.update_id);
    return;
  }

  return origProcessUpdate(update);
};
server.genSessions = genSessions;

// ── Bridge via hooks (no full start override needed) ───────────────────────
let bridgeRestarts = 0;
server.beforePoll = async function () {
  startBridge(AGENT_DIR, this.log.bind(this), this.logError.bind(this));

  // Startup notification (custom: includes dispatcher + queue)
  if (this.config.CHAT_ID) {
    setTimeout(async () => {
      try {
        const ds = getDispatcherStatus();
        const q = getQueueSnapshot();
        await this.tg.sendMessage(this.config.CHAT_ID,
          `<b>${this.agentDisplayName}</b> online.\n` +
            `Dispatcher: ${ds.running ? `running (PID ${ds.pid})` : "not running"}\n` +
            `Queue: ${q.todo.length} pending, ${q.inProgress.length} running\n` +
            `Bridge: active\n` +
            `<i>Queue-based execution — no time limits.</i>`
        );
      } catch {}
    }, 1000);
  }

  // Watchdog: restart bridge if it crashes (max 3/hour)
  this._bridgeWatchdog = setInterval(() => {
    if (!isBridgeRunning() && bridgeRestarts < 3) {
      this.log("Bridge watchdog: restarting...");
      startBridge(AGENT_DIR, this.log.bind(this), this.logError.bind(this));
      bridgeRestarts++;
    }
  }, 30000);
};

server.afterStop = function () {
  if (this._bridgeWatchdog) clearInterval(this._bridgeWatchdog);
  stopBridge();
};

// ── Start ──────────────────────────────────────────────────────────────────
process.on("SIGINT", () => { server.stop(); server.log("SIGINT"); });
process.on("SIGTERM", () => { server.stop(); server.log("SIGTERM"); });
process.on("uncaughtException", (err) => {
  stopBridge();
  server.logError("FATAL", "Uncaught", err.message + "\n" + (err.stack || ""));
  process.exit(1);
});
process.on("unhandledRejection", (r) => {
  server.logError("ERROR", "Unhandled rejection", r?.message || String(r));
  process.exit(1);
});

server.start();
