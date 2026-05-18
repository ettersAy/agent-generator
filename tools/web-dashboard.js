#!/usr/bin/env node
/**
 * Agent Generator Dashboard — Web interface for missions, agents, and logs.
 *
 * Uses shared lib modules for all data access.
 * Built-in HTTP server (Node.js only, no dependencies).
 *
 * Routes:
 *   GET /              → Dashboard HTML
 *   GET /wiki           → System wiki / documentation
 *   GET /api/agents     → Agent list
 *   GET /api/queue      → Mission queue snapshot
 *   GET /api/logs       → Recent dispatcher + server logs
 *   GET /api/status     → Full system status (all-in-one)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { listAgents } = require("./lib/agents");
const { getQueueSnapshot, getDispatcherStatus, getLogTail } = require("./lib/queue");

const AGENT_DIR = "/srv/dev/agents/agent-generator";
const PORT = parseInt(process.argv[2], 10) || 3099;

// ── HTML escaping ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(iso) {
  if (!iso && !(iso instanceof Date)) return "—";
  const diff = Date.now() - (iso instanceof Date ? iso.getTime() : new Date(iso).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── CSS (shared across pages) ───────────────────────────────────────────────
const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#e1e4e8;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:10px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.header h1{font-size:18px;color:#58a6ff;white-space:nowrap}
.header nav{display:flex;gap:12px;align-items:center}
.header nav a{color:#8b949e;text-decoration:none;font-size:13px;padding:4px 8px;border-radius:4px}
.header nav a:hover,.header nav a.active{color:#e1e4e8;background:#21262d}
.stats-bar{background:#0d1117;border-bottom:1px solid #21262d;padding:8px 24px;display:flex;gap:24px;flex-wrap:wrap;font-size:12px;color:#8b949e}
.stat{display:flex;align-items:center;gap:6px}
.stat .dot{width:8px;height:8px;border-radius:50%}
.stat .dot.green{background:#3fb950}
.stat .dot.red{background:#f85149}
.stat .dot.yellow{background:#d29922}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px;padding:16px 24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
.card h2{font-size:14px;padding:10px 16px;background:#0d1117;border-bottom:1px solid #21262d;color:#58a6ff;display:flex;justify-content:space-between;align-items:center}
.card h2 .badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600}
.badge.green{background:#1b3824;color:#3fb950}
.badge.red{background:#3a1c1c;color:#f85149}
.badge.yellow{background:#342b10;color:#d29922}
.card-body{padding:12px 16px;font-size:13px}
.mission-row{display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:1px solid #21262d;gap:8px}
.mission-row:last-child{border-bottom:none}
.mission-id{font-family:monospace;font-size:11px;color:#58a6ff;white-space:nowrap}
.mission-title{flex:1;color:#c9d1d9;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mission-meta{font-size:10px;color:#484f58;white-space:nowrap}
.empty-state{padding:16px;text-align:center;color:#484f58;font-style:italic;font-size:13px}
.log-view{background:#0d1117;font-family:monospace;font-size:11px;padding:12px 16px;max-height:300px;overflow-y:auto;white-space:pre-wrap;color:#8b949e;line-height:1.5}
.agent-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #21262d}
.agent-row:last-child{border-bottom:none}
.tag{font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600}
.tag.online{background:#1b3824;color:#3fb950}
.tag.offline{background:#3a1c1c;color:#f85149}
@media(max-width:768px){.grid{grid-template-columns:1fr;padding:12px}.header{padding:10px 12px}}
`;

// ── Dashboard Page ──────────────────────────────────────────────────────────
function renderDashboard() {
  const agents = listAgents();
  const queue = getQueueSnapshot();
  const dispatcher = getDispatcherStatus();
  const serverLog = getLogTail(path.join(AGENT_DIR, "logs", "unified-server.log"), 20);
  const dispatchLog = getLogTail(path.join(AGENT_DIR, "logs", "dispatcher.log"), 20);

  const serverPidFile = path.join(AGENT_DIR, ".unified-server.pid");
  let serverRunning = false;
  if (fs.existsSync(serverPidFile)) {
    try { process.kill(parseInt(fs.readFileSync(serverPidFile, "utf8")), 0); serverRunning = true; } catch {}
  }

  // ── Status bar ──────────────────────────────────────────────────────────
  const stats = [
    `<span class="stat"><span class="dot ${serverRunning ? 'green' : 'red'}"></span> Server: ${serverRunning ? 'ONLINE' : 'OFFLINE'}</span>`,
    `<span class="stat"><span class="dot ${dispatcher.running ? 'green' : 'red'}"></span> Dispatcher: ${dispatcher.running ? 'ONLINE' : 'OFFLINE'}</span>`,
    `<span class="stat">Queue: ${queue.todo.length} pending / ${queue.inProgress.length} running</span>`,
    `<span class="stat">Agents: ${agents.filter(a=>a.running).length}/${agents.length} online</span>`,
  ].join("");

  // ── Mission queue cards ─────────────────────────────────────────────────
  function missionCard(label, items, icon, maxShow = 10) {
    const show = items.slice(0, maxShow);
    const rows = show.length === 0
      ? '<div class="empty-state">None</div>'
      : show.map(m => `
        <div class="mission-row">
          <span class="mission-id">${esc(m.id.slice(-35))}</span>
          <span class="mission-title" title="${esc(m.title)}">${esc(m.title.slice(0, 60))}</span>
          <span class="mission-meta">${m.runnerAlive ? '🟢 live' : ''} ${timeAgo(m.mtime)}</span>
        </div>`).join("");

    const extra = items.length > maxShow ? `<div class="empty-state">+ ${items.length - maxShow} more</div>` : "";
    return `<div class="card">
      <h2>${icon} ${label} <span class="badge ${items.length > 0 ? 'green' : ''}">${items.length}</span></h2>
      <div class="card-body">${rows}${extra}</div>
    </div>`;
  }

  // ── Agent card ──────────────────────────────────────────────────────────
  const agentRows = agents.length === 0
    ? '<div class="empty-state">No agents found</div>'
    : agents.map(a => `
      <div class="agent-row">
        <div>
          <strong>${esc(a.name)}</strong>
          <span style="color:#8b949e;margin-left:8px;font-size:11px">${esc(a.description || '')}</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span style="font-size:11px;color:#484f58">${a.messageCount} msgs</span>
          <span class="tag ${a.running ? 'online' : 'offline'}">${a.running ? 'ONLINE' : 'OFFLINE'}</span>
        </div>
      </div>`).join("");

  const agentCard = `<div class="card">
    <h2>🤖 Agents <span class="badge green">${agents.length}</span></h2>
    <div class="card-body">${agentRows}</div>
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI Agents Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div class="header">
  <h1>🧠 AI Agents Dashboard</h1>
  <nav>
    <a href="/" class="active">Dashboard</a>
    <a href="/wiki">Wiki</a>
    <a href="javascript:location.reload()">↻ Refresh</a>
  </nav>
</div>
<div class="stats-bar">${stats}</div>
<div class="grid">
  ${missionCard('In Progress', queue.inProgress, '🔄', 10)}
  ${missionCard('Queued', queue.todo, '⏳', 10)}
  ${agentCard}
  ${missionCard('Done', queue.done.slice(-8), '✅', 5)}
  ${missionCard('Failed', queue.failed.slice(-8), '❌', 5)}
  <div class="card">
    <h2>📋 Server Logs</h2>
    <div class="log-view">${esc(serverLog || '(no server logs yet)')}</div>
  </div>
  <div class="card">
    <h2>🔄 Dispatcher Logs</h2>
    <div class="log-view">${esc(dispatchLog || '(no dispatcher logs yet)')}</div>
  </div>
</div>
</body>
</html>`;
}

// ── Wiki Page ───────────────────────────────────────────────────────────────
function renderWiki() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>System Wiki — Agent Generator</title>
<style>${CSS}
.wiki-content{max-width:900px;margin:0 auto;padding:24px;line-height:1.7}
.wiki-content h2{color:#58a6ff;font-size:18px;margin:24px 0 10px;border-bottom:1px solid #21262d;padding-bottom:6px}
.wiki-content h3{color:#e1e4e8;font-size:15px;margin:16px 0 8px}
.wiki-content p,.wiki-content li{color:#8b949e;font-size:14px;margin:6px 0}
.wiki-content code{background:#21262d;padding:2px 6px;border-radius:4px;font-size:12px;color:#58a6ff}
.wiki-content pre{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px 16px;overflow-x:auto;font-size:12px;line-height:1.5;color:#c9d1d9;margin:10px 0}
.wiki-content table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
.wiki-content th{background:#0d1117;padding:8px 12px;text-align:left;border:1px solid #30363d;color:#58a6ff}
.wiki-content td{padding:8px 12px;border:1px solid #21262d;color:#8b949e}
</style>
</head>
<body>
<div class="header">
  <h1>🧠 System Wiki</h1>
  <nav>
    <a href="/">Dashboard</a>
    <a href="/wiki" class="active">Wiki</a>
    <a href="javascript:location.reload()">↻ Refresh</a>
  </nav>
</div>
<div class="wiki-content">

<h2>Architecture Overview</h2>
<p>The Agent Generator system is a queue-based AI mission execution platform. It receives missions via Telegram, queues them, and executes them using Claude CLI in fully isolated processes.</p>

<h3>Core Principle: Process Isolation</h3>
<p>Claude processes run completely independently from the Telegram bot and dispatcher. If any component crashes, Claude keeps running. Results are always captured to disk.</p>

<h2>System Components</h2>
<table>
<tr><th>Component</th><th>Type</th><th>Role</th></tr>
<tr><td><code>unified-server.js</code></td><td>Node.js</td><td>Telegram polling, message routing, quick AI responses</td></tr>
<tr><td><code>mission-dispatcher.sh</code></td><td>Shell daemon</td><td>Watches <code>missions/todo/</code>, spawns runners, orphan recovery</td></tr>
<tr><td><code>mission-runner.sh</code></td><td>Shell script</td><td>Executes Claude CLI per mission, captures output, sends notification</td></tr>
<tr><td><code>web-dashboard.js</code></td><td>Node.js HTTP</td><td>Web dashboard + wiki (this page)</td></tr>
</table>

<h2>Mission Lifecycle</h2>
<pre>
missions/todo/        → Newly queued (waiting for dispatch)
missions/in-progress/ → Currently executing (runner active, .pid file present)
missions/done/        → Completed successfully (result file exists)
missions/failed/      → Failed or timed out
missions/results/     → Raw Claude output (*_result.md)
</pre>

<h2>Data Flow</h2>
<pre>
Telegram Message
  → Node.js Server saves .md to missions/todo/
  → Server acknowledges to user
  → Dispatcher (5s poll) picks up .md
  → Moves to missions/in-progress/
  → Spawns: nohup bash mission-runner.sh &lt;file&gt; &
  → Runner: claude -p "..." > result.md 2>&1
  → Claude exits → runner reads result
  → Runner sends Telegram notification
  → Runner moves mission to done/ or failed/
</pre>

<h2>Key Design Decisions</h2>
<table>
<tr><th>Decision</th><th>Reason</th></tr>
<tr><td>Shell-based dispatcher, not Node.js</td><td>No memory issues with long-running process management</td></tr>
<tr><td>Claude output → disk (redirect)</td><td>Zero RAM consumption regardless of mission duration</td></tr>
<tr><td>nohup for Claude processes</td><td>Survives parent death, terminal close, dispatcher restart</td></tr>
<tr><td>Post-exit notification by shell</td><td>Doesn't depend on Claude remembering to send messages</td></tr>
<tr><td>Max 2 concurrent Claude processes</td><td>Prevents resource exhaustion</td></tr>
<tr><td>Filesystem as IPC</td><td>.md, .pid, _result.md files — crash-safe communication</td></tr>
<tr><td>4h stuck timeout</td><td>Missions running >4h with dead runner → auto-failed</td></tr>
</table>

<h2>Directory Structure</h2>
<pre>
/srv/dev/agents/agent-generator/
├── tools/
│   ├── lib/                  ← Shared packages
│   │   ├── env.sh            ← Environment + path config
│   │   ├── logging.sh        ← Logging + notifications
│   │   ├── process.sh        ← PID + process management
│   │   ├── missions.sh       ← Mission queue helpers
│   │   ├── agents.js         ← Agent discovery
│   │   ├── queue.js          ← Queue snapshot + status
│   │   └── generation.js     ← Agent generation sessions
│   ├── mission-runner.sh     ← Single mission executor
│   ├── telegram-server.js    ← Telegram bot (thin router)
│   ├── web-dashboard.js      ← Web interface
│   └── telegram-send.sh      ← Send Telegram messages
├── scripts/
│   ├── mission-dispatcher.sh ← Background daemon
│   ├── telegram-start.sh     ← Start all services
│   ├── telegram-stop.sh      ← Stop all services
│   └── telegram-status.sh    ← Health check
└── missions/                 ← todo/ → in-progress/ → done/ or failed/
</pre>

<h2>Commands Reference</h2>
<table>
<tr><th>Command</th><th>Action</th></tr>
<tr><td><code>tg-start</code></td><td>Start server + dispatcher</td></tr>
<tr><td><code>tg-stop</code></td><td>Stop server + dispatcher (Claude survives)</td></tr>
<tr><td><code>tg-status</code></td><td>Full health check</td></tr>
<tr><td><code>dispatch-log</code></td><td>Follow dispatcher logs</td></tr>
<tr><td><code>mq</code></td><td>Quick mission queue overview</td></tr>
<tr><td><code>/mission task</code></td><td>Queue mission via Telegram</td></tr>
<tr><td><code>/queue</code></td><td>View queue via Telegram</td></tr>
<tr><td><code>/cancel id</code></td><td>Cancel pending mission</td></tr>
</table>

<h2>Shared Libraries (SOLID)</h2>
<p>Each library has a single responsibility:</p>
<table>
<tr><th>Library</th><th>Responsibility</th><th>Used by</th></tr>
<tr><td><code>tools/lib/env.sh</code></td><td>Environment loading, path config</td><td>All shell scripts</td></tr>
<tr><td><code>tools/lib/logging.sh</code></td><td>Structured logging, HTML escape, TG notifications</td><td>Runner, dispatcher, status</td></tr>
<tr><td><code>tools/lib/process.sh</code></td><td>PID files, process alive checks, runner counting</td><td>Dispatcher, start, stop, status</td></tr>
<tr><td><code>tools/lib/missions.sh</code></td><td>Mission file CRUD, result file paths</td><td>Runner, dispatcher</td></tr>
<tr><td><code>tools/lib/agents.js</code></td><td>Agent discovery + status</td><td>Server, dashboard</td></tr>
<tr><td><code>tools/lib/queue.js</code></td><td>Queue snapshot, dispatcher status, log tails</td><td>Server, dashboard</td></tr>
<tr><td><code>tools/lib/generation.js</code></td><td>Agent generation session state machine</td><td>Server</td></tr>
</table>

<h2>APIs</h2>
<table>
<tr><th>Endpoint</th><th>Returns</th></tr>
<tr><td><code>GET /api/agents</code></td><td>JSON — all agents with status</td></tr>
<tr><td><code>GET /api/queue</code></td><td>JSON — full mission queue snapshot</td></tr>
<tr><td><code>GET /api/status</code></td><td>JSON — combined agents + queue + logs</td></tr>
</table>

</div>
</body>
</html>`;
}

// ── API handlers ────────────────────────────────────────────────────────────
function json(res, data) {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/agents") return json(res, listAgents());
  if (url.pathname === "/api/queue") return json(res, getQueueSnapshot());

  if (url.pathname === "/api/status") {
    return json(res, {
      agents: listAgents(),
      queue: getQueueSnapshot(),
      dispatcher: getDispatcherStatus(),
      serverLog: getLogTail(path.join(AGENT_DIR, "logs", "unified-server.log"), 30),
      dispatchLog: getLogTail(path.join(AGENT_DIR, "logs", "dispatcher.log"), 30),
    });
  }

  // Pages
  const html = url.pathname === "/wiki" ? renderWiki() : renderDashboard();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Wiki:     http://localhost:${PORT}/wiki`);
  console.log(`API:      http://localhost:${PORT}/api/status`);
});
