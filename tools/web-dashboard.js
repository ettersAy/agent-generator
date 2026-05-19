#!/usr/bin/env node
/**
 * Agent Generator Dashboard — Enhanced web interface with wiki, controls, and API.
 *
 * Zero external dependencies — Node.js built-ins only.
 *
 * Routes:
 *   GET /                    → Dashboard HTML
 *   GET /wiki                → Wiki index (lists all doc pages)
 *   GET /wiki/:page          → Wiki page rendered from docs/*.md
 *   GET /mission?id=<id>     → Mission detail page
 *   GET /agent?name=<name>   → Agent detail page
 *   GET /logs?source=&lines= → Enhanced log viewer page
 *
 * API:
 *   GET /api/agents           → Agent list JSON
 *   GET /api/agents/:name     → Agent detail JSON
 *   GET /api/queue            → Queue snapshot JSON
 *   GET /api/missions/:id     → Mission detail JSON
 *   GET /api/status           → Full system status JSON
 *   GET /api/logs/:source     → Log content (query: ?lines=100&filter=TEXT)
 *   POST /api/services/:name/:action → Service control (start|stop|restart)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const { listAgents, getAgentDetail } = require("./lib/agents");
const { getQueueSnapshot, getDispatcherStatus, getLogTail, MISSIONS_DIR } = require("./lib/queue");

const AGENT_DIR = "/srv/dev/agents/agent-generator";
const DOCS_DIR = path.join(AGENT_DIR, "docs");
const PORT = parseInt(process.argv[2], 10) || 3099;

// ── Utilities ─────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function timeAgo(iso) {
  if (!iso && !(iso instanceof Date)) return "—";
  const diff = Date.now() - (iso instanceof Date ? iso.getTime() : new Date(iso).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function pidAlive(pidFile) {
  if (!fs.existsSync(pidFile)) return false;
  try { process.kill(parseInt(fs.readFileSync(pidFile, "utf8")), 0); return true; } catch { return false; }
}

// ── Minimal Markdown to HTML renderer ─────────────────────────────────────────
function md2html(md) {
  let html = md;
  // Code blocks (``` ... ```) — must run before inline code
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang || 'text'}">${esc(code.trimEnd())}</code></pre>`;
  });
  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Headers
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");
  // Bold, italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Tables — convert markdown tables to HTML
  html = html.replace(/(^\|.+\|$\n^\|[-| :]+\|$\n(?:^\|.+\|$\n?)*)/gm, (table) => {
    const rows = table.trim().split("\n").filter((r) => !r.match(/^\|[-| :]+\|$/));
    const cells = rows.map((r) => r.split("|").slice(1, -1).map((c) => c.trim()));
    if (cells.length === 0) return "";
    const thead = `<tr>${cells[0].map((c) => `<th>${c}</th>`).join("")}</tr>`;
    const tbody = cells.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  });
  // Horizontal rules
  html = html.replace(/^---+$/gm, "<hr>");
  // Unordered lists
  html = html.replace(/((?:^- .+$\n?)+)/gm, (list) => {
    const items = list.trim().split("\n").filter((l) => l.startsWith("- ")).map((l) => `<li>${l.slice(2)}</li>`).join("");
    return `<ul>${items}</ul>`;
  });
  // Ordered lists
  html = html.replace(/((?:^\d+\. .+$\n?)+)/gm, (list) => {
    const items = list.trim().split("\n").filter((l) => /^\d+\./.test(l)).map((l) => `<li>${l.replace(/^\d+\.\s*/, "")}</li>`).join("");
    return `<ol>${items}</ol>`;
  });
  // Paragraphs — double newlines separate paragraphs
  html = html.replace(/\n\n+/g, "</p><p>");
  html = "<p>" + html + "</p>";
  // Clean up: remove empty paragraphs and fix block elements inside paragraphs
  html = html.replace(/<p>\s*<(h[2-4]|table|pre|ul|ol|hr|blockquote)/g, "<$1");
  html = html.replace(/(\/h[2-4]>|\/table>|\/pre>|\/ul>|\/ol>|\/hr>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*<\/p>/g, "");
  html = html.replace(/\n/g, "");
  return html;
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#e1e4e8;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:10px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;position:sticky;top:0;z-index:10}
.header h1{font-size:18px;color:#58a6ff;white-space:nowrap}
.header nav{display:flex;gap:12px;align-items:center}
.header nav a{color:#8b949e;text-decoration:none;font-size:13px;padding:4px 8px;border-radius:4px;transition:background .15s,color .15s}
.header nav a:hover,.header nav a.active{color:#e1e4e8;background:#21262d}
.hamburger{display:none;background:none;border:1px solid #30363d;color:#c9d1d9;padding:4px 10px;border-radius:4px;font-size:18px;cursor:pointer}
.stats-bar{background:#0d1117;border-bottom:1px solid #21262d;padding:8px 24px;display:flex;gap:24px;flex-wrap:wrap;font-size:12px;color:#8b949e}
.stat{display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot.green{background:#3fb950}
.dot.red{background:#f85149}
.dot.yellow{background:#d29922}
.dot.pulse{animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px;padding:16px 24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
.card h2{font-size:14px;padding:10px 16px;background:#0d1117;border-bottom:1px solid #21262d;color:#58a6ff;display:flex;justify-content:space-between;align-items:center}
.card h2 .badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600}
.badge.green{background:#1b3824;color:#3fb950}
.badge.red{background:#3a1c1c;color:#f85149}
.badge.yellow{background:#342b10;color:#d29922}
.card-body{padding:12px 16px;font-size:13px}
.controls-bar{display:flex;gap:8px;padding:8px 16px;background:#0d1117;border-bottom:1px solid #21262d;flex-wrap:wrap;align-items:center}
.btn{padding:6px 12px;border:1px solid #30363d;border-radius:6px;background:#21262d;color:#c9d1d9;font-size:12px;cursor:pointer;transition:background .15s;white-space:nowrap}
.btn:hover{background:#30363d}
.btn.green{border-color:#238636;color:#3fb950}
.btn.green:hover{background:#1b3824}
.btn.red{border-color:#da3633;color:#f85149}
.btn.red:hover{background:#3a1c1c}
.btn.active-toggle{background:#1b3824;border-color:#238636;color:#3fb950}
.mission-row{display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:1px solid #21262d;gap:8px}
.mission-row:last-child{border-bottom:none}
.mission-row a{text-decoration:none;flex:1;min-width:0}
.mission-id{font-family:monospace;font-size:11px;color:#58a6ff;white-space:nowrap}
.mission-title{color:#c9d1d9;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.mission-meta{font-size:10px;color:#484f58;white-space:nowrap}
.empty-state{padding:16px;text-align:center;color:#484f58;font-style:italic;font-size:13px}
.loading{padding:16px;text-align:center;color:#484f58;font-size:13px}
.loading::after{content:'...';animation:dots 1.5s steps(4,end) infinite}
@keyframes dots{0%,20%{content:'.'}40%{content:'..'}60%{content:'...'}80%,100%{content:''}}
.log-view{background:#0d1117;font-family:'SF Mono','Fira Code',monospace;font-size:11px;padding:12px 16px;max-height:400px;overflow-y:auto;white-space:pre-wrap;color:#8b949e;line-height:1.5}
.log-view .error{color:#f85149}
.log-view .warn{color:#d29922}
.agent-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #21262d}
.agent-row:last-child{border-bottom:none}
.agent-row a{color:#58a6ff;text-decoration:none;font-weight:600}
.agent-row a:hover{text-decoration:underline}
.tag{font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600}
.tag.online{background:#1b3824;color:#3fb950}
.tag.offline{background:#3a1c1c;color:#f85149}
.detail-page{max-width:1000px;margin:0 auto;padding:24px}
.detail-page h2{color:#58a6ff;font-size:18px;margin:24px 0 10px;border-bottom:1px solid #21262d;padding-bottom:6px}
.detail-page h3{color:#e1e4e8;font-size:15px;margin:16px 0 8px}
.detail-page h4{color:#8b949e;font-size:13px;margin:12px 0 6px}
.detail-page p,.detail-page li{color:#8b949e;font-size:14px;margin:6px 0;line-height:1.7}
.detail-page code{background:#21262d;padding:2px 6px;border-radius:4px;font-size:12px;color:#58a6ff}
.detail-page pre{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px 16px;overflow-x:auto;font-size:12px;line-height:1.5;color:#c9d1d9;margin:10px 0}
.detail-page table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
.detail-page th{background:#0d1117;padding:8px 12px;text-align:left;border:1px solid #30363d;color:#58a6ff}
.detail-page td{padding:8px 12px;border:1px solid #21262d;color:#8b949e}
.detail-page ul,.detail-page ol{margin:8px 0;padding-left:24px}
.detail-page a{color:#58a6ff}
.detail-page hr{border:none;border-top:1px solid #21262d;margin:16px 0}
.detail-back{display:inline-block;margin-bottom:16px;color:#8b949e;text-decoration:none;font-size:13px}
.detail-back:hover{color:#58a6ff}
.meta-table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
.meta-table td{padding:6px 12px;border:1px solid #21262d;color:#8b949e}
.meta-table td:first-child{color:#58a6ff;font-weight:600;width:140px;background:#0d1117}
.service-card{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #21262d}
.service-card:last-child{border-bottom:none}
.service-name{font-weight:600;color:#e1e4e8}
.service-status{display:flex;gap:8px;align-items:center}
.search-bar{display:flex;gap:6px;align-items:center}
.search-bar input,.search-bar select{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:4px 8px;border-radius:4px;font-size:12px}
.search-bar input:focus{outline:none;border-color:#58a6ff}
.wiki-index{max-width:700px;margin:24px auto;padding:0 24px}
.wiki-index a{display:block;padding:8px 12px;color:#58a6ff;text-decoration:none;border-bottom:1px solid #21262d;font-size:14px;transition:background .15s}
.wiki-index a:hover{background:#161b22}
.wiki-index a small{color:#484f58;font-size:11px}
.toast{position:fixed;bottom:20px;right:20px;background:#1b3824;color:#3fb950;padding:8px 16px;border-radius:6px;font-size:12px;z-index:100;opacity:0;transition:opacity .3s}
.toast.show{opacity:1}
.toast.error{background:#3a1c1c;color:#f85149}
@media(max-width:768px){
  .grid{grid-template-columns:1fr;padding:12px}
  .header{padding:10px 12px}
  .header nav{gap:6px}
  .header nav a{font-size:11px;padding:3px 6px}
  .hamburger{display:block}
  .header nav.collapsed{display:none;flex-direction:column;width:100%}
  .header nav.show{display:flex}
  .detail-page{padding:12px}
  .stats-bar{padding:8px 12px;gap:12px;font-size:11px}
  .controls-bar{overflow-x:auto;flex-wrap:nowrap}
}
`;

// ── Header HTML ────────────────────────────────────────────────────────────────
function headerHtml(active) {
  const links = [
    ["/", "Dashboard"],
    ["/wiki", "Wiki"],
    ["/logs", "Logs"],
  ];
  return `<div class="header">
  <h1>🧠 AI Agents</h1>
  <button class="hamburger" onclick="this.nextElementSibling.classList.toggle('show')" aria-label="Menu">☰</button>
  <nav class="collapsed" id="nav">
    ${links.map(([href, label]) => `<a href="${href}"${active === label.toLowerCase() ? ' class="active"' : ''}>${label}</a>`).join("")}
    <a href="javascript:location.reload()" title="Refresh">↻</a>
  </nav>
</div>`;
}

// ── Dashboard Page ─────────────────────────────────────────────────────────────
function renderDashboard() {
  const agents = listAgents();
  const queue = getQueueSnapshot();
  const dispatcher = getDispatcherStatus();
  const serverRunning = pidAlive(path.join(AGENT_DIR, ".unified-server.pid"));
  const dashboardRunning = true; // we're serving this page
  const dispatcherRunning = dispatcher.running;

  const stats = [
    `<span class="stat"><span class="dot ${serverRunning ? 'green' : 'red'}"></span> Server: ${serverRunning ? 'ONLINE' : 'OFFLINE'}</span>`,
    `<span class="stat"><span class="dot ${dispatcherRunning ? 'green' : 'red'}"></span> Dispatcher: ${dispatcherRunning ? 'ONLINE' : 'OFFLINE'}</span>`,
    `<span class="stat">Queue: ${queue.todo.length} / ${queue.inProgress.length}</span>`,
    `<span class="stat">Agents: ${agents.filter(a=>a.running).length}/${agents.length} online</span>`,
  ].join("");

  function missionCard(label, items, icon, maxShow = 10) {
    const show = items.slice(0, maxShow);
    const rows = show.length === 0
      ? '<div class="empty-state">None</div>'
      : show.map(m => `
        <div class="mission-row">
          <a href="/mission?id=${esc(encodeURIComponent(m.id))}">
            <span class="mission-title" title="${esc(m.title)}">${esc(m.title.slice(0, 70))}</span>
          </a>
          <span class="mission-meta">${m.runnerAlive ? '<span class="dot green pulse" style="display:inline-block;width:6px;height:6px" title="live"></span>' : ''} ${timeAgo(m.mtime)}</span>
        </div>`).join("");

    const extra = items.length > maxShow ? `<div class="empty-state">+ ${items.length - maxShow} more</div>` : "";
    return `<div class="card">
      <h2>${icon} ${label} <span class="badge ${items.length > 0 ? 'green' : ''}">${items.length}</span></h2>
      <div class="card-body">${rows}${extra}</div>
    </div>`;
  }

  const agentRows = agents.length === 0
    ? '<div class="empty-state">No agents found</div>'
    : agents.map(a => `
      <div class="agent-row">
        <div>
          <a href="/agent?name=${esc(encodeURIComponent(a.name))}">${esc(a.name)}</a>
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

  // Service controls
  const services = [
    { name: "unified-server", label: "Telegram Server", running: serverRunning, pidFile: ".unified-server.pid" },
    { name: "mission-dispatcher", label: "Mission Dispatcher", running: dispatcherRunning, pidFile: ".mission-dispatcher.pid" },
    { name: "web-dashboard", label: "Web Dashboard", running: dashboardRunning, pidFile: ".web-dashboard.pid" },
  ];

  const serviceRows = services.map(s => {
    let pid = "—";
    if (s.running && fs.existsSync(path.join(AGENT_DIR, s.pidFile))) {
      try { pid = fs.readFileSync(path.join(AGENT_DIR, s.pidFile), "utf8").trim(); } catch {}
    }
    return `<div class="service-card">
      <div>
        <span class="service-name">${esc(s.label)}</span>
        <span style="font-size:11px;color:#484f58;margin-left:8px">PID: ${esc(String(pid))}</span>
      </div>
      <div class="service-status">
        <span class="tag ${s.running ? 'online' : 'offline'}">${s.running ? 'ONLINE' : 'OFFLINE'}</span>
        ${s.name !== 'web-dashboard' ? `
          <button class="btn ${s.running ? 'red' : 'green'}" onclick="controlService('${s.name}','${s.running ? 'stop' : 'start'}')">${s.running ? 'Stop' : 'Start'}</button>
        ` : ''}
      </div>
    </div>`;
  }).join("");

  const controlsCard = `<div class="card">
    <h2>🎛️ Service Controls</h2>
    <div class="card-body">${serviceRows}</div>
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI Agents Dashboard</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("dashboard")}
<div class="stats-bar">${stats}</div>
<div class="controls-bar">
  <button class="btn active-toggle" id="autorefresh-btn" onclick="toggleAutoRefresh()" title="Auto-refresh every 30s">⏱ Auto-Refresh: OFF</button>
  <span style="font-size:11px;color:#484f58;margin-left:auto" id="refresh-time"></span>
</div>
<div class="grid">
  ${missionCard('In Progress', queue.inProgress, '🔄', 10)}
  ${missionCard('Queued', queue.todo, '⏳', 10)}
  ${agentCard}
  ${controlsCard}
  ${missionCard('Recently Done', queue.done.slice(-8).reverse(), '✅', 5)}
  ${missionCard('Recently Failed', queue.failed.slice(-8).reverse(), '❌', 5)}
</div>
<div id="toast" class="toast"></div>
<script>
let autoRefresh = false;
let refreshTimer = null;

function toggleAutoRefresh() {
  autoRefresh = !autoRefresh;
  const btn = document.getElementById('autorefresh-btn');
  if (autoRefresh) {
    btn.textContent = '⏱ Auto-Refresh: ON (30s)';
    btn.classList.add('active-toggle');
    refreshTimer = setInterval(() => location.reload(), 30000);
  } else {
    btn.textContent = '⏱ Auto-Refresh: OFF';
    btn.classList.remove('active-toggle');
    if (refreshTimer) clearInterval(refreshTimer);
  }
}

function controlService(name, action) {
  if (name === 'web-dashboard' && action === 'stop') {
    if (!confirm('Stopping the dashboard will close this page. Continue?')) return;
  }
  fetch('/api/services/' + name + '/' + action, {method:'POST'})
    .then(r => r.json())
    .then(d => {
      showToast(d.ok ? 'Service ' + name + ' ' + action + ' OK' : 'Error: ' + (d.error || 'unknown'), !d.ok);
      setTimeout(() => location.reload(), 1500);
    })
    .catch(e => showToast('Request failed: ' + e.message, true));
}

function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

document.getElementById('refresh-time').textContent = 'Updated: ' + new Date().toLocaleTimeString();

document.addEventListener('keydown', e => { if (e.key === 'r' && e.ctrlKey) { e.preventDefault(); location.reload(); } });
</script>
</body>
</html>`;
}

// ── Mission Detail Page ────────────────────────────────────────────────────────
function renderMissionDetail(missionId) {
  const queue = getQueueSnapshot();
  const allMissions = [...queue.todo, ...queue.inProgress, ...queue.done, ...queue.failed];
  const mission = allMissions.find((m) => m.id === missionId);

  if (!mission) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not Found</title><style>${CSS}</style></head><body>
    ${headerHtml("")}<div class="detail-page"><a class="detail-back" href="/">← Back to Dashboard</a><h2>Mission Not Found</h2><p>No mission with ID: ${esc(missionId)}</p></div></body></html>`;
  }

  // Determine which directory the mission file is in
  let missionDir = "";
  for (const [key, dir] of Object.entries({ todo: "todo", inProgress: "in-progress", done: "done", failed: "failed" })) {
    if (mission[key] || key === mission.status) { missionDir = dir; break; }
  }
  if (!missionDir) {
    if (mission.status === "todo") missionDir = "todo";
    else if (mission.status === "in-progress" || mission.status === "dispatched") missionDir = "in-progress";
    else missionDir = "done";
  }

  const missionFile = path.join(MISSIONS_DIR, missionDir, mission.filename);
  let missionContent = "";
  if (fs.existsSync(missionFile)) {
    try { missionContent = fs.readFileSync(missionFile, "utf8"); } catch {}
  }

  // Result file
  const resultFile = path.join(MISSIONS_DIR, "results", mission.filename.replace(".md", "_result.md"));
  let resultContent = "";
  if (fs.existsSync(resultFile)) {
    try { resultContent = fs.readFileSync(resultFile, "utf8"); } catch {}
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Mission: ${esc(mission.title.slice(0, 60))}</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("")}
<div class="detail-page">
<a class="detail-back" href="/">← Back to Dashboard</a>
<h2>Mission: ${esc(mission.title)}</h2>
<table class="meta-table">
<tr><td>ID</td><td><code>${esc(mission.id)}</code></td></tr>
<tr><td>Status</td><td><span class="tag ${mission.runnerAlive ? 'online' : (mission.status === 'done' ? 'online' : (mission.status === 'failed' ? 'offline' : 'offline'))}">${esc(mission.status)}</span></td></tr>
<tr><td>File</td><td><code>missions/${esc(missionDir)}/${esc(mission.filename)}</code></td></tr>
<tr><td>Last Modified</td><td>${esc(mission.mtime.toISOString())} (${timeAgo(mission.mtime)})</td></tr>
<tr><td>Runner PID</td><td>${esc(String(mission.pid))}</td></tr>
<tr><td>Runner Alive</td><td>${mission.runnerAlive ? 'Yes' : 'No'}</td></tr>
<tr><td>Result Size</td><td>${mission.resultSize ? (mission.resultSize > 1024 ? Math.round(mission.resultSize/1024) + ' KB' : mission.resultSize + ' B') : 'No result yet'}</td></tr>
</table>
<h3>Mission Content</h3>
<div class="detail-page" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:16px;max-height:500px;overflow-y:auto;font-size:13px">
${md2html(missionContent)}
</div>
${resultContent ? `
<h3>Result</h3>
<div class="detail-page" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:16px;max-height:600px;overflow-y:auto;font-size:13px">
${md2html(resultContent)}
</div>` : ''}
</div>
</body>
</html>`;
}

// ── Agent Detail Page ──────────────────────────────────────────────────────────
function renderAgentDetail(agentName) {
  const agents = listAgents();
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not Found</title><style>${CSS}</style></head><body>
    ${headerHtml("")}<div class="detail-page"><a class="detail-back" href="/">← Back to Dashboard</a><h2>Agent Not Found</h2><p>No agent named: ${esc(agentName)}</p></div></body></html>`;
  }

  // Try to read agent's mission queue
  let agentQueue = { todo: 0, inProgress: 0, done: 0, failed: 0 };
  const agentMissionsDir = path.join(agent.path, "missions");
  if (fs.existsSync(agentMissionsDir)) {
    for (const dir of ["todo", "in-progress", "done", "failed"]) {
      const d = path.join(agentMissionsDir, dir);
      if (fs.existsSync(d)) {
        try { agentQueue[dir === "in-progress" ? "inProgress" : dir] = fs.readdirSync(d).filter((f) => f.endsWith(".md")).length; } catch {}
      }
    }
  }

  // Try reading CLAUDE.md excerpt
  let claudeMdExcerpt = "";
  const claudeMdPath = path.join(agent.path, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    try {
      const content = fs.readFileSync(claudeMdPath, "utf8");
      claudeMdExcerpt = content.slice(0, 3000);
    } catch {}
  }

  // Check agent's own dashboard
  let agentDashboardPort = "";
  let agentDashboardRunning = false;
  const agentDashboardPid = path.join(agent.path, ".web-dashboard.pid");
  if (fs.existsSync(agentDashboardPid)) {
    try {
      const pid = parseInt(fs.readFileSync(agentDashboardPid, "utf8"));
      process.kill(pid, 0);
      agentDashboardRunning = true;
      agentDashboardPort = "3099"; // default
    } catch {}
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Agent: ${esc(agent.name)}</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("")}
<div class="detail-page">
<a class="detail-back" href="/">← Back to Dashboard</a>
<h2>Agent: ${esc(agent.name)}</h2>
<table class="meta-table">
<tr><td>Name</td><td><strong>${esc(agent.name)}</strong></td></tr>
<tr><td>Path</td><td><code>${esc(agent.path)}</code></td></tr>
<tr><td>Description</td><td>${esc(agent.description)}</td></tr>
<tr><td>Status</td><td><span class="tag ${agent.running ? 'online' : 'offline'}">${agent.running ? 'ONLINE' : 'OFFLINE'}</span></td></tr>
<tr><td>PID</td><td>${esc(String(agent.pid || '—'))}</td></tr>
<tr><td>Messages</td><td>${agent.messageCount}</td></tr>
<tr><td>Web Dashboard</td><td>${agentDashboardRunning ? `<span class="tag online">RUNNING</span>` : '<span class="tag offline">OFFLINE</span>'}</td></tr>
</table>
<h3>Mission Queue</h3>
<table class="meta-table">
<tr><td>Todo</td><td>${agentQueue.todo}</td></tr>
<tr><td>In Progress</td><td>${agentQueue.inProgress}</td></tr>
<tr><td>Done</td><td>${agentQueue.done}</td></tr>
<tr><td>Failed</td><td>${agentQueue.failed}</td></tr>
</table>
${claudeMdExcerpt ? `
<h3>CLAUDE.md (excerpt)</h3>
<div class="detail-page" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:16px;max-height:500px;overflow-y:auto;font-size:13px">
${md2html(claudeMdExcerpt)}
</div>` : ''}
</div>
</body>
</html>`;
}

// ── Log Viewer Page ────────────────────────────────────────────────────────────
function renderLogViewer(query) {
  const source = query.get("source") || "unified-server";
  const lines = parseInt(query.get("lines")) || 100;
  const filter = query.get("filter") || "";

  const logSources = {
    "unified-server": { path: path.join(AGENT_DIR, "logs", "unified-server.log"), label: "Telegram Server" },
    "dispatcher": { path: path.join(AGENT_DIR, "logs", "dispatcher.log"), label: "Mission Dispatcher" },
    "web-dashboard": { path: path.join(AGENT_DIR, "logs", "web-dashboard.log"), label: "Web Dashboard" },
    "errors": { path: path.join(AGENT_DIR, "logs", "errors.log"), label: "Errors" },
  };

  const sourceInfo = logSources[source] || logSources["unified-server"];
  let logContent = "";
  if (fs.existsSync(sourceInfo.path)) {
    try {
      let content = fs.readFileSync(sourceInfo.path, "utf8");
      const allLines = content.split("\n").filter(Boolean);
      let filteredLines = allLines;
      if (filter) {
        const lowerFilter = filter.toLowerCase();
        filteredLines = allLines.filter((l) => l.toLowerCase().includes(lowerFilter));
      }
      logContent = filteredLines.slice(-lines).join("\n");
    } catch {}
  }

  // Apply syntax highlighting
  const highlighted = logContent.split("\n").map((line) => {
    if (/error|fail|fatal|crash/i.test(line)) return `<span class="error">${esc(line)}</span>`;
    if (/warn|warning/i.test(line)) return `<span class="warn">${esc(line)}</span>`;
    return esc(line);
  }).join("\n");

  const sourceOptions = Object.entries(logSources).map(([key, info]) =>
    `<option value="${key}"${key === source ? ' selected' : ''}>${esc(info.label)}</option>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Log Viewer</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("logs")}
<div class="detail-page">
<a class="detail-back" href="/">← Back to Dashboard</a>
<h2>Log Viewer: ${esc(sourceInfo.label)}</h2>
<div class="controls-bar" style="margin-bottom:12px;border:1px solid #30363d;border-radius:6px">
  <div class="search-bar">
    <label style="font-size:11px;color:#484f58">Source:</label>
    <select onchange="updateSource(this.value)">${sourceOptions}</select>
    <label style="font-size:11px;color:#484f58;margin-left:8px">Lines:</label>
    <select onchange="updateLines(this.value)">
      ${[50, 100, 200, 500, 1000].map((n) => `<option value="${n}"${n === lines ? ' selected' : ''}>${n}</option>`).join("")}
    </select>
    <label style="font-size:11px;color:#484f58;margin-left:8px">Filter:</label>
    <input type="text" id="filter-input" value="${esc(filter)}" placeholder="keyword..." onkeydown="if(event.key==='Enter')applyFilter()">
    <button class="btn" onclick="applyFilter()">Apply</button>
    <button class="btn" onclick="location.href='/logs?source=${esc(source)}&lines=${lines}'">Clear</button>
  </div>
  <span style="font-size:11px;color:#484f58;margin-left:auto">${logContent.split('\\n').length} lines</span>
</div>
<div class="log-view">${highlighted || '<span style="color:#484f58">No log content found</span>'}</div>
</div>
<script>
function updateSource(v) {
  const params = new URLSearchParams(location.search);
  params.set('source', v);
  location.search = params.toString();
}
function updateLines(v) {
  const params = new URLSearchParams(location.search);
  params.set('lines', v);
  location.search = params.toString();
}
function applyFilter() {
  const params = new URLSearchParams(location.search);
  const val = document.getElementById('filter-input').value.trim();
  if (val) params.set('filter', val);
  else params.delete('filter');
  location.search = params.toString();
}
</script>
</body>
</html>`;
}

// ── Wiki Index Page ────────────────────────────────────────────────────────────
function renderWikiIndex() {
  let docFiles = [];
  if (fs.existsSync(DOCS_DIR)) {
    try {
      docFiles = fs.readdirSync(DOCS_DIR)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {}
  }

  const items = docFiles.length === 0
    ? '<p style="text-align:center;color:#484f58;padding:24px">No documentation files found</p>'
    : docFiles.map((f) => {
        const name = f.replace(".md", "");
        const label = name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        let stat = "";
        try { stat = ` — ${fs.statSync(path.join(DOCS_DIR, f)).size} bytes`; } catch {}
        return `<a href="/wiki/${encodeURIComponent(name)}">${esc(label)} <small>${stat}</small></a>`;
      }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>System Wiki — Agent Generator</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("wiki")}
<h2 style="padding:24px;text-align:center;color:#58a6ff">📚 Documentation Wiki</h2>
<div class="wiki-index">
${items}
</div>
</body>
</html>`;
}

// ── Wiki Content Page ──────────────────────────────────────────────────────────
function renderWikiPage(pageName) {
  // Security: only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(pageName)) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Invalid Page</title><style>${CSS}</style></head><body>
    ${headerHtml("wiki")}<div class="detail-page"><a class="detail-back" href="/wiki">← Back to Wiki</a><h2>Invalid Page Name</h2></div></body></html>`;
  }

  const mdPath = path.join(DOCS_DIR, pageName + ".md");
  if (!fs.existsSync(mdPath)) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not Found</title><style>${CSS}</style></head><body>
    ${headerHtml("wiki")}<div class="detail-page"><a class="detail-back" href="/wiki">← Back to Wiki</a><h2>Page Not Found</h2><p>No documentation page: ${esc(pageName)}</p></div></body></html>`;
  }

  let mdContent = "";
  try { mdContent = fs.readFileSync(mdPath, "utf8"); } catch {}

  const title = pageName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(title)} — Wiki</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("wiki")}
<div class="detail-page">
<a class="detail-back" href="/wiki">← Back to Wiki Index</a>
${md2html(mdContent)}
</div>
</body>
</html>`;
}

// ── JSON Helpers ───────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

// ── Service Control ────────────────────────────────────────────────────────────
function controlService(name, action) {
  return new Promise((resolve) => {
    const scripts = {
      "unified-server": {
        start: path.join(AGENT_DIR, "scripts", "telegram-start.sh"),
        stop: path.join(AGENT_DIR, "scripts", "telegram-stop.sh"),
      },
      "mission-dispatcher": {
        start: path.join(AGENT_DIR, "scripts", "mission-dispatcher.sh"),
        stop: null, // handled via process kill
      },
    };

    const svc = scripts[name];
    if (!svc) return resolve({ ok: false, error: `Unknown service: ${name}` });
    if (action !== "start" && action !== "stop") return resolve({ ok: false, error: `Unknown action: ${action}` });

    if (name === "mission-dispatcher" && action === "stop") {
      const pidFile = path.join(AGENT_DIR, ".mission-dispatcher.pid");
      if (fs.existsSync(pidFile)) {
        try {
          const pid = parseInt(fs.readFileSync(pidFile, "utf8"));
          process.kill(pid, "SIGTERM");
          fs.unlinkSync(pidFile);
        } catch {}
      }
      return resolve({ ok: true, action: "stop", service: name });
    }

    if (name === "unified-server" && action === "stop") {
      const pidFile = path.join(AGENT_DIR, ".unified-server.pid");
      if (fs.existsSync(pidFile)) {
        try {
          const pid = parseInt(fs.readFileSync(pidFile, "utf8"));
          process.kill(pid, "SIGTERM");
          fs.unlinkSync(pidFile);
        } catch {}
      }
      return resolve({ ok: true, action: "stop", service: name });
    }

    if (action === "start") {
      const scriptPath = svc.start;
      if (!fs.existsSync(scriptPath)) return resolve({ ok: false, error: `Script not found: ${scriptPath}` });
      exec(`bash "${scriptPath}"`, { cwd: AGENT_DIR, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: stderr || err.message });
        resolve({ ok: true, action: "start", service: name, output: stdout.trim() });
      });
    } else {
      resolve({ ok: true, action, service: name });
    }
  });
}

// ── HTTP Server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  // ── API Routes ──────────────────────────────────────────────────────────

  // POST /api/services/:name/:action
  if (req.method === "POST" && pathname.startsWith("/api/services/")) {
    const parts = pathname.replace("/api/services/", "").split("/");
    if (parts.length === 2) {
      const result = await controlService(parts[0], parts[1]);
      return json(res, result, result.ok ? 200 : 400);
    }
    return json(res, { ok: false, error: "Invalid path" }, 400);
  }

  // GET /api/agents
  if (pathname === "/api/agents") return json(res, listAgents());

  // GET /api/agents/:name
  if (pathname.startsWith("/api/agents/")) {
    const name = decodeURIComponent(pathname.replace("/api/agents/", ""));
    const agent = listAgents().find((a) => a.name === name);
    if (!agent) return json(res, { error: "Agent not found" }, 404);
    return json(res, agent);
  }

  // GET /api/queue
  if (pathname === "/api/queue") return json(res, getQueueSnapshot());

  // GET /api/missions/:id
  if (pathname.startsWith("/api/missions/")) {
    const missionId = decodeURIComponent(pathname.replace("/api/missions/", ""));
    const queue = getQueueSnapshot();
    const allMissions = [...queue.todo, ...queue.inProgress, ...queue.done, ...queue.failed];
    const mission = allMissions.find((m) => m.id === missionId);
    if (!mission) return json(res, { error: "Mission not found" }, 404);
    return json(res, mission);
  }

  // GET /api/status
  if (pathname === "/api/status") {
    return json(res, {
      agents: listAgents(),
      queue: getQueueSnapshot(),
      dispatcher: getDispatcherStatus(),
      serverRunning: pidAlive(path.join(AGENT_DIR, ".unified-server.pid")),
      serverLog: getLogTail(path.join(AGENT_DIR, "logs", "unified-server.log"), 30),
      dispatchLog: getLogTail(path.join(AGENT_DIR, "logs", "dispatcher.log"), 30),
    });
  }

  // GET /api/logs/:source
  if (pathname.startsWith("/api/logs/")) {
    const source = pathname.replace("/api/logs/", "");
    const lines = parseInt(url.searchParams.get("lines")) || 100;
    const filter = url.searchParams.get("filter") || "";

    const logPaths = {
      "unified-server": path.join(AGENT_DIR, "logs", "unified-server.log"),
      "dispatcher": path.join(AGENT_DIR, "logs", "dispatcher.log"),
      "web-dashboard": path.join(AGENT_DIR, "logs", "web-dashboard.log"),
      "errors": path.join(AGENT_DIR, "logs", "errors.log"),
    };

    const logPath = logPaths[source];
    if (!logPath) return json(res, { error: "Unknown log source", available: Object.keys(logPaths) }, 400);

    let content = "";
    if (fs.existsSync(logPath)) {
      try {
        let raw = fs.readFileSync(logPath, "utf8");
        let allLines = raw.split("\n").filter(Boolean);
        if (filter) {
          const lf = filter.toLowerCase();
          allLines = allLines.filter((l) => l.toLowerCase().includes(lf));
        }
        content = allLines.slice(-lines).join("\n");
      } catch {}
    }
    return json(res, { source, lines, filter, content, lineCount: content ? content.split("\n").length : 0 });
  }

  // ── Page Routes ─────────────────────────────────────────────────────────

  // GET /logs — log viewer page
  if (pathname === "/logs") {
    const html = renderLogViewer(url.searchParams);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // GET /wiki — wiki index
  if (pathname === "/wiki") {
    const html = renderWikiIndex();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // GET /wiki/:page — wiki content page
  if (pathname.startsWith("/wiki/")) {
    const pageName = decodeURIComponent(pathname.replace("/wiki/", ""));
    const html = renderWikiPage(pageName);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // GET /mission?id= — mission detail
  if (pathname === "/mission") {
    const missionId = url.searchParams.get("id");
    if (!missionId) {
      res.writeHead(302, { Location: "/" });
      return res.end();
    }
    const html = renderMissionDetail(missionId);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // GET /agent?name= — agent detail
  if (pathname === "/agent") {
    const agentName = url.searchParams.get("name");
    if (!agentName) {
      res.writeHead(302, { Location: "/" });
      return res.end();
    }
    const html = renderAgentDetail(agentName);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // GET / — dashboard
  if (pathname === "/") {
    const html = renderDashboard();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(html);
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>404</title><style>${CSS}</style></head><body>
    ${headerHtml("")}<div class="detail-page"><h2>404 — Not Found</h2><p><a href="/">Back to Dashboard</a></p></div></body></html>`);
});

server.listen(PORT, () => {
  console.log(`Dashboard:  http://localhost:${PORT}/`);
  console.log(`Wiki:      http://localhost:${PORT}/wiki`);
  console.log(`Logs:      http://localhost:${PORT}/logs`);
  console.log(`API:       http://localhost:${PORT}/api/status`);
  console.log(`Services:  http://localhost:${PORT}  (POST /api/services/:name/:action)`);
});
