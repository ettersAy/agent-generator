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
.form-group{margin-bottom:12px}
.form-group label{display:block;font-size:12px;color:#8b949e;margin-bottom:4px;font-weight:600}
.form-group input,.form-group textarea,.form-group select{width:100%;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:8px 12px;border-radius:6px;font-size:13px;font-family:inherit}
.form-group input:focus,.form-group textarea:focus,.form-group select:focus{outline:none;border-color:#58a6ff}
.form-group textarea{resize:vertical;min-height:80px}
.form-group .hint{font-size:10px;color:#484f58;margin-top:2px}
.form-actions{display:flex;gap:8px;margin-top:16px}
.form-card{max-width:700px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px 24px}
.form-card h2{color:#58a6ff;font-size:16px;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #21262d}
.form-progress{display:flex;gap:4px;margin-bottom:20px}
.form-progress .step-dot{flex:1;height:4px;background:#21262d;border-radius:2px}
.form-progress .step-dot.done{background:#3fb950}
.form-progress .step-dot.current{background:#58a6ff}
.form-row{display:flex;gap:12px}
.form-row .form-group{flex:1}
.mailbox-msg{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px 16px;margin-bottom:8px;font-size:12px}
.mailbox-msg .msg-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:4px}
.mailbox-msg .msg-from{color:#58a6ff;font-weight:600}
.mailbox-msg .msg-to{color:#3fb950;font-weight:600}
.mailbox-msg .msg-date{color:#484f58;font-size:10px}
.mailbox-msg .msg-type{font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600}
.mailbox-msg .msg-type.question{background:#1b3824;color:#3fb950}
.mailbox-msg .msg-type.answer{background:#1b3824;color:#3fb950}
.mailbox-msg .msg-type.config-request{background:#341a4a;color:#bc8cff}
.mailbox-msg .msg-type.incident{background:#3a1c1c;color:#f85149}
.mailbox-msg .msg-body{padding:8px;background:#161b22;border-radius:4px;color:#8b949e;margin-top:6px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto}
.incident-card{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px 16px;margin-bottom:8px;font-size:12px}
.incident-card .incident-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:4px}
.incident-card .incident-agent{color:#58a6ff;font-weight:600}
.incident-card .incident-type{font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600;text-transform:uppercase}
.incident-card .incident-type.bridge_down{background:#3a1c1c;color:#f85149}
.incident-card .incident-type.message_lost{background:#342b10;color:#d29922}
.incident-card .incident-type.duplicate_messages{background:#342b10;color:#d29922}
.incident-card .incident-type.error_loop{background:#3a1c1c;color:#f85149}
.incident-card .incident-type.timeout{background:#342b10;color:#d29922}
.incident-card .incident-type.manual{background:#1b3824;color:#3fb950}
.incident-card .incident-detail{padding:8px;background:#161b22;border-radius:4px;color:#8b949e;margin-top:6px;white-space:pre-wrap;word-break:break-word}
.incident-card .incident-date{color:#484f58;font-size:10px}
.sys-stat{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #21262d;font-size:12px}
.sys-stat:last-child{border-bottom:none}
.sys-stat-label{color:#8b949e;min-width:120px}
.sys-stat-value{color:#c9d1d9;font-family:monospace}
.sys-stat-bar{flex:1;height:6px;background:#21262d;border-radius:3px;overflow:hidden;max-width:200px}
.sys-stat-fill{height:100%;background:#3fb950;border-radius:3px;transition:width .5s}
.sys-stat-fill.warn{background:#d29922}
.sys-stat-fill.crit{background:#f85149}
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
    ["/generate", "Generate"],
    ["/mission/new", "New Mission"],
    ["/mailbox", "Mailbox"],
    ["/incidents", "Incidents"],
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
      ${(() => {
        const stats = getSystemStats();
        const rows = Object.entries(stats.processes).map(([name, p]) => {
          const memPercent = p.memMB ? Math.min(100, (parseFloat(p.memMB) / 500) * 100) : 0;
          const barClass = memPercent > 80 ? 'crit' : (memPercent > 50 ? 'warn' : '');
          return '<div class="sys-stat"><span class="sys-stat-label">' + esc(name) + '</span><span class="sys-stat-value">PID ' + esc(String(p.pid)) + ' | ' + esc(String(p.memMB || '?')) + ' MB | ' + esc(String(p.uptime || '?')) + '</span><div class="sys-stat-bar"><div class="sys-stat-fill ' + barClass + '" style="width:' + memPercent + '%"></div></div></div>';
        }).join("");
        const q = stats.queueCounts;
        const a = stats.agentCounts;
        return '<div class="card"><h2>📊 System Stats</h2><div class="card-body">' +
          rows +
          '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #21262d;display:flex;gap:16px;font-size:11px;color:#8b949e;flex-wrap:wrap">' +
          '<span>Queue: ' + q.todo + ' todo | ' + q.inProgress + ' running | ' + q.done + ' done | ' + q.failed + ' failed</span>' +
          '<span>Agents: ' + a.online + '/' + a.total + ' online</span>' +
          '</div></div></div>';
      })()}

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
    <button class="btn active-toggle" id="live-btn" onclick="toggleLive()" style="margin-left:8px">🔴 Live</button>
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

let liveStream = null;
function toggleLive() {
  const btn = document.getElementById('live-btn');
  const logDiv = document.querySelector('.log-view');
  if (liveStream) {
    // Stop streaming
    liveStream.close();
    liveStream = null;
    btn.textContent = '🔴 Live';
    btn.classList.remove('active-toggle');
    return;
  }
  // Start streaming
  btn.textContent = '⏸ Stop Live';
  btn.classList.add('active-toggle');

  const params = new URLSearchParams(location.search);
  const source = params.get('source') || 'unified-server';
  liveStream = new EventSource('/api/logs/stream/' + source);

  liveStream.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const lineEl = document.createElement('div');
    if (data.class) lineEl.className = data.class;
    lineEl.textContent = data.line;

    // Escape HTML in the line except for our classes
    if (!data.class) {
      lineEl.textContent = '';
      lineEl.appendChild(document.createTextNode(data.line));
    }

    logDiv.appendChild(lineEl);
    logDiv.scrollTop = logDiv.scrollHeight;

    // Keep max 1000 lines in view
    while (logDiv.children.length > 1000) {
      logDiv.removeChild(logDiv.firstChild);
    }
  };

  liveStream.onerror = () => {
    liveStream.close();
    liveStream = null;
    btn.textContent = '🔴 Live';
    btn.classList.remove('active-toggle');
  };
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


// ── Agent Generation Form ───────────────────────────────────────────────────
function renderGenerateForm() {
  const steps = [
    { key: "AGENT_NAME", label: "Agent name (kebab-case)", hint: "e.g. my-bot" },
    { key: "AGENT_DISPLAY_NAME", label: "Agent display name", hint: "e.g. My Bot" },
    { key: "AGENT_DIR", label: "Agent directory", hint: "Full path, e.g. /srv/dev/agents/my-bot" },
    { key: "PROJECT_DIR", label: "Project directory", hint: "Full path, e.g. /srv/dev/my-app" },
    { key: "PROJECT_NAME", label: "Project short name", hint: "e.g. MyApp" },
    { key: "PROJECT_DESCRIPTION", label: "Project description", hint: "One-line description" },
    { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", hint: "From @BotFather" },
    { key: "TELEGRAM_CHAT_ID", label: "Telegram chat ID", hint: "Your numeric chat ID" },
    { key: "ANTHROPIC_AUTH_TOKEN", label: "AI API auth token", hint: "DeepSeek or Anthropic key" },
    { key: "ANTHROPIC_BASE_URL", label: "AI API base URL", hint: "e.g. https://api.deepseek.com/anthropic" },
    { key: "GITHUB_REPO", label: "GitHub repo", hint: "owner/repo" },
    { key: "PROD_URL", label: "Production URL", hint: "e.g. https://myapp.com" },
    { key: "AGENT_USERNAME", label: "Bot username", hint: "e.g. @MyAppBot" },
    { key: "AGENT_ROLE", label: "Agent role description", hint: "One-line role description" },
  ];

  const stepInputs = steps.map((s, i) => `
    <div class="form-group">
      <label>${esc(s.label)} <span style="color:#484f58;font-weight:400">(step ${i + 1}/14)</span></label>
      <input type="text" id="field-${esc(s.key)}" placeholder="${esc(s.hint)}" />
    </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Generate Agent</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("generate")}
<div class="detail-page">
<a class="detail-back" href="/">← Back to Dashboard</a>
<div class="form-card">
<h2>🧬 Generate New AI Agent</h2>
<p style="color:#8b949e;font-size:12px;margin-bottom:16px">Fill in all fields to generate a complete AI agent with Telegram bot, mission queue, and full configuration.</p>
<div class="form-progress" id="progress-bar">
  ${steps.map(() => '<div class="step-dot"></div>').join("")}
</div>
<form id="gen-form" onsubmit="submitGeneration(event)">
${stepInputs}
<div class="form-actions">
  <button type="submit" class="btn green" id="submit-btn">⚡ Generate Agent</button>
  <button type="reset" class="btn" onclick="resetProgress()">Reset</button>
</div>
</form>
<div id="gen-result" style="margin-top:16px;display:none"></div>
</div>
</div>
<script>
function updateProgress() {
  const fields = document.querySelectorAll('#gen-form input[type=text]');
  let filled = 0;
  fields.forEach(f => { if (f.value.trim()) filled++; });
  const dots = document.querySelectorAll('#progress-bar .step-dot');
  dots.forEach((d, i) => {
    d.className = 'step-dot' + (i < filled ? ' done' : '') + (i === filled ? ' current' : '');
  });
}
document.querySelectorAll('#gen-form input[type=text]').forEach(i => {
  i.addEventListener('input', updateProgress);
});

async function submitGeneration(e) {
  e.preventDefault();
  const fields = document.querySelectorAll('#gen-form input[type=text]');
  const data = {};
  fields.forEach(f => { data[f.id.replace('field-', '')] = f.value.trim(); });

  // Validate all fields
  const missing = Object.entries(data).filter(([k, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    showResult('Please fill all fields. Missing: ' + missing.join(', '), true);
    return;
  }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Generating...';
  showResult('Generating agent... this may take up to 60 seconds.', false);

  try {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    });
    const result = await resp.json();
    if (result.ok) {
      showResult('<strong>Agent generated successfully!</strong><br><br><pre style=\"background:#0d1117;padding:12px;border-radius:4px;max-height:300px;overflow-y:auto;font-size:11px\">' + esc(result.output || '') + '</pre><br><a href=\"/agent?name=\' + esc(result.agentName) + '\" style=\"color:#58a6ff\">View Agent →</a>', false);
    } else {
      showResult('Error: ' + (result.error || 'Unknown error'), true);
    }
  } catch(e) {
    showResult('Request failed: ' + e.message, true);
  }
  btn.disabled = false;
  btn.textContent = '⚡ Generate Agent';
}

function showResult(msg, isError) {
  const div = document.getElementById('gen-result');
  div.style.display = 'block';
  div.style.padding = '12px 16px';
  div.style.borderRadius = '6px';
  div.style.fontSize = '13px';
  div.style.background = isError ? '#3a1c1c' : '#1b3824';
  div.style.color = isError ? '#f85149' : '#3fb950';
  div.style.border = '1px solid ' + (isError ? '#da3633' : '#238636');
  div.innerHTML = msg;
}

function resetProgress() {
  setTimeout(updateProgress, 50);
}
</script>
</body>
</html>`;
}

// ── Mission Creation Form ────────────────────────────────────────────────────
function renderMissionForm() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>New Mission</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("new mission")}
<div class="detail-page">
<a class="detail-back" href="/">← Back to Dashboard</a>
<div class="form-card">
<h2>📋 Queue New Mission</h2>
<p style="color:#8b949e;font-size:12px;margin-bottom:16px">Create a mission that will be picked up by the dispatcher and executed by a Claude CLI worker.</p>
<form onsubmit="submitMission(event)">
<div class="form-group">
  <label>Mission Title</label>
  <input type="text" id="mission-title" placeholder="e.g. Fix the login bug in Moussawer" required />
</div>
<div class="form-group">
  <label>Description / Tasks</label>
  <textarea id="mission-body" rows="8" placeholder="Describe what needs to be done. Be specific about tasks, files, and expected outcomes.&#10;&#10;Example:&#10;1. Read src/auth/login.ts&#10;2. Fix the token refresh logic&#10;3. Test with invalid tokens" required></textarea>
  <div class="hint">Supports markdown. This will be saved as the mission file and executed by Claude.</div>
</div>
<div class="form-group">
  <label>Source</label>
  <input type="text" id="mission-source" placeholder="e.g. Telegram, Web Dashboard" value="Web Dashboard" />
</div>
<div class="form-actions">
  <button type="submit" class="btn green" id="submit-btn">📤 Queue Mission</button>
  <button type="reset" class="btn">Reset</button>
</div>
</form>
<div id="mission-result" style="margin-top:16px;display:none"></div>
</div>
</div>
<script>
async function submitMission(e) {
  e.preventDefault();
  const title = document.getElementById('mission-title').value.trim();
  const body = document.getElementById('mission-body').value.trim();
  const source = document.getElementById('mission-source').value.trim() || 'Web Dashboard';
  if (!title || !body) return;

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Creating...';

  try {
    const resp = await fetch('/api/missions/create', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ title, body, source })
    });
    const result = await resp.json();
    const div = document.getElementById('mission-result');
    div.style.display = 'block';
    div.style.padding = '12px 16px';
    div.style.borderRadius = '6px';
    div.style.fontSize = '13px';
    if (result.ok) {
      div.style.background = '#1b3824';
      div.style.color = '#3fb950';
      div.style.border = '1px solid #238636';
      div.innerHTML = '<strong>Mission queued!</strong> ID: <code>' + esc(result.id) + '</code><br>View in <a href=\"/mission?id=\' + esc(result.id) + '\" style=\"color:#58a6ff\">Mission Detail</a>';
      document.getElementById('mission-title').value = '';
      document.getElementById('mission-body').value = '';
    } else {
      div.style.background = '#3a1c1c';
      div.style.color = '#f85149';
      div.style.border = '1px solid #da3633';
      div.textContent = 'Error: ' + (result.error || 'Unknown');
    }
  } catch(e) {
    const div = document.getElementById('mission-result');
    div.style.display = 'block';
    div.style.background = '#3a1c1c';
    div.style.color = '#f85149';
    div.style.border = '1px solid #da3633';
    div.style.padding = '12px 16px';
    div.style.borderRadius = '6px';
    div.style.fontSize = '13px';
    div.textContent = 'Request failed: ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = '📤 Queue Mission';
}
</script>
</body>
</html>`;
}

// ── Inter-Agent Mailbox Viewer ───────────────────────────────────────────────
function getMailboxMessages() {
  const SHARED = "/srv/dev/agents/_shared";
  const mailboxDir = path.join(SHARED, "mailbox");
  const messages = [];
  if (!fs.existsSync(mailboxDir)) return messages;

  try {
    const agents = fs.readdirSync(mailboxDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const agent of agents) {
      const inboxDir = path.join(mailboxDir, agent, "inbox");
      if (!fs.existsSync(inboxDir)) continue;
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json")).sort().reverse();
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(inboxDir, f), "utf8");
          const msg = JSON.parse(raw);
          messages.push({
            ...msg,
            _recipient: agent,
            _file: f,
            _mtime: fs.statSync(path.join(inboxDir, f)).mtime
          });
        } catch {}
      }
    }
  } catch {}
  return messages;
}

function renderMailbox(agentFilter) {
  let messages = getMailboxMessages();
  if (agentFilter) {
    messages = messages.filter(m =>
      m._recipient === agentFilter || m.from === agentFilter
    );
  }

  const agents = new Set();
  messages.forEach(m => {
    agents.add(m._recipient);
    if (m.from) agents.add(m.from);
  });

  const filterOptions = ['<option value="">All Agents</option>']
    .concat([...agents].sort().map(a =>
      `<option value="${esc(a)}"${agentFilter === a ? ' selected' : ''}>${esc(a)}</option>`
    )).join("");

  const msgHtml = messages.length === 0
    ? '<div class="empty-state">No messages found</div>'
    : messages.map(m => `
      <div class="mailbox-msg">
        <div class="msg-header">
          <div>
            <span class="msg-from">${esc(m.from || '?')}</span>
            <span style="color:#8b949e"> → </span>
            <span class="msg-to">${esc(m._recipient)}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="msg-type ${esc(m.type || 'question')}">${esc(m.type || 'question')}</span>
            <span class="msg-date">${m._mtime ? m._mtime.toISOString().slice(0,19).replace('T',' ') : '—'}</span>
          </div>
        </div>
        <div class="msg-body">${esc(typeof m.message === 'string' ? m.message : JSON.stringify(m.message, null, 2))}</div>
      </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Inter-Agent Mailbox</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("mailbox")}
<div class="detail-page">
<a class="detail-back" href="/">← Back to Dashboard</a>
<h2>📬 Inter-Agent Mailbox <span class="badge green" style="font-size:10px">${messages.length} msgs</span></h2>
<div class="controls-bar" style="margin:0 0 12px;border:1px solid #30363d;border-radius:6px">
  <div class="search-bar">
    <label style="font-size:11px;color:#484f58">Filter Agent:</label>
    <select onchange="location.search=this.value?'agent='+this.value:''">
      ${filterOptions}
    </select>
  </div>
  <span style="font-size:11px;color:#484f58;margin-left:auto">${messages.length} messages</span>
</div>
${msgHtml}
</div>
</body>
</html>`;
}

// ── Incident Viewer ──────────────────────────────────────────────────────────
function getIncidents() {
  const incidentsDir = "/srv/dev/agents/_shared/incidents";
  const incidents = [];
  if (!fs.existsSync(incidentsDir)) return incidents;
  try {
    const files = fs.readdirSync(incidentsDir).filter(f => f.endsWith(".json")).sort().reverse();
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(incidentsDir, f), "utf8");
        const inc = JSON.parse(raw);
        inc._file = f;
        inc._mtime = fs.statSync(path.join(incidentsDir, f)).mtime;
        incidents.push(inc);
      } catch {}
    }
  } catch {}
  return incidents;
}

function renderIncidents() {
  const incidents = getIncidents();
  const items = incidents.length === 0
    ? '<div class="empty-state">No incidents reported — system is healthy</div>'
    : incidents.map(inc => `
      <div class="incident-card">
        <div class="incident-header">
          <div>
            <span class="incident-agent">${esc(inc.agent || inc.from || '?')}</span>
            <span class="incident-type ${esc((inc.type || 'manual').replace(/_/g, '-'))}">${esc((inc.type || 'manual').replace(/_/g, ' '))}</span>
          </div>
          <span class="incident-date">${inc._mtime ? inc._mtime.toISOString().slice(0,19).replace('T',' ') : '—'}</span>
        </div>
        <div class="incident-detail">${esc(inc.detail || inc.message || JSON.stringify(inc))}</div>
      </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Incident Reports</title>
<style>${CSS}</style>
</head>
<body>
${headerHtml("incidents")}
<div class="detail-page">
<a class="detail-back" href="/">← Back to Dashboard</a>
<h2>🚨 Incident Reports <span class="badge ${incidents.length > 0 ? 'red' : 'green'}" style="font-size:10px">${incidents.length}</span></h2>
<div class="form-card" style="margin-bottom:20px">
<h3 style="color:#e1e4e8;font-size:14px;margin-bottom:12px">Report New Incident</h3>
<form onsubmit="reportIncident(event)">
<div class="form-row">
  <div class="form-group">
    <label>Type</label>
    <select id="incident-type">
      <option value="manual">Manual</option>
      <option value="bridge_down">Bridge Down</option>
      <option value="message_lost">Message Lost</option>
      <option value="duplicate_messages">Duplicate Messages</option>
      <option value="error_loop">Error Loop</option>
      <option value="timeout">Timeout</option>
    </select>
  </div>
  <div class="form-group">
    <label>Agent</label>
    <input type="text" id="incident-agent" placeholder="agent name" value="agent-generator" />
  </div>
</div>
<div class="form-group">
  <label>Description</label>
  <textarea id="incident-detail" rows="3" placeholder="Describe the problem..." required></textarea>
</div>
<div class="form-actions">
  <button type="submit" class="btn red">🚨 Report Incident</button>
</div>
</form>
</div>
${items}
</div>
<script>
async function reportIncident(e) {
  e.preventDefault();
  const type = document.getElementById('incident-type').value;
  const agent = document.getElementById('incident-agent').value.trim();
  const detail = document.getElementById('incident-detail').value.trim();
  if (!detail) return;

  try {
    const resp = await fetch('/api/incidents/report', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ type, agent, detail })
    });
    const result = await resp.json();
    if (result.ok) {
      location.reload();
    } else {
      alert('Error: ' + (result.error || 'Unknown'));
    }
  } catch(e) {
    alert('Request failed: ' + e.message);
  }
}
</script>
</body>
</html>`;
}

// ── System Stats Helper ──────────────────────────────────────────────────────
function getSystemStats() {
  const { execSync } = require("child_process");
  const stats = {};

  // Process memory for key processes
  const pids = {};
  const pidFiles = {
    unifiedServer: path.join(AGENT_DIR, ".unified-server.pid"),
    dispatcher: path.join(AGENT_DIR, ".mission-dispatcher.pid"),
    dashboard: path.join(AGENT_DIR, ".web-dashboard.pid"),
  };
  for (const [name, pf] of Object.entries(pidFiles)) {
    if (fs.existsSync(pf)) {
      try {
        pids[name] = parseInt(fs.readFileSync(pf, "utf8"));
      } catch {}
    }
  }

  const procStats = {};
  for (const [name, pid] of Object.entries(pids)) {
    try {
      const out = execSync(`ps -p ${pid} -o rss=,etime=,pcpu= 2>/dev/null || echo ""`, { encoding: "utf8", timeout: 3000 }).trim();
      if (out) {
        const parts = out.trim().split(/\s+/);
        procStats[name] = {
          pid,
          memMB: parts[0] ? (parseInt(parts[0]) / 1024).toFixed(1) : null,
          uptime: parts[1] || null,
          cpu: parts[2] || null,
        };
      }
    } catch {}
  }
  stats.processes = procStats;

  // Queue counts
  const queue = getQueueSnapshot();
  stats.queueCounts = {
    todo: queue.todo.length,
    inProgress: queue.inProgress.length,
    done: queue.done.length,
    failed: queue.failed.length,
  };

  // Agent counts
  const agents = listAgents();
  stats.agentCounts = {
    total: agents.length,
    online: agents.filter(a => a.running).length,
  };

  return stats;
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
  
    // POST /api/generate — run agent generation
    if (req.method === "POST" && pathname === "/api/generate") {
      const body = await readBody(req);
      try {
        const data = JSON.parse(body);
        const genPath = "/srv/dev/agents/agent-generator/tools/generate-agent.sh";
        const configPath = "/tmp/web-gen-config-" + Date.now() + ".env";
        const lines = Object.entries(data).map(([k, v]) => k + "=" + v);
        fs.writeFileSync(configPath, lines.join("\n"));
        const { execSync } = require("child_process");
        let output = "";
        let ok = false;
        let error = "";
        try {
          output = execSync('bash "' + genPath + '" --config "' + configPath + '"', {
            cwd: AGENT_DIR, encoding: "utf8", timeout: 60000
          });
          ok = true;
        } catch (e) {
          error = (e.stderr || e.message || "").toString();
        }
        try { fs.unlinkSync(configPath); } catch {}
        return json(res, { ok, output: output.trim(), error, agentName: data.AGENT_NAME || "" });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    }

    // POST /api/missions/create — queue a new mission
    if (req.method === "POST" && pathname === "/api/missions/create") {
      const body = await readBody(req);
      try {
        const data = JSON.parse(body);
        if (!data.title || !data.body) {
          return json(res, { ok: false, error: "Title and body required" }, 400);
        }
        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" +
          String(Math.floor(Math.random() * 10000)).padStart(4, "0");
        const id = ts;
        const safeTitle = data.title.replace(/[^a-zA-Z0-9 -]/g, "").toLowerCase().slice(0, 60);
        const filename = id + "-" + safeTitle.replace(/\s+/g, "-") + ".md";
        const missionContent = `# Mission: "${esc(data.title)}"

| Field | Detail |
|-------|--------|
| **Created** | ${now.toISOString()} |
| **Status** | todo |
| **Source** | ${esc(data.source || "Web Dashboard")} |
| **PID** | - |

## Original Request

${data.body}

## Progress Log

| Timestamp | Event | Detail |
|-----------|-------|--------|
| ${now.toISOString()} | created | Mission queued from web dashboard |
`;
        const todoDir = path.join(MISSIONS_DIR, "todo");
        if (!fs.existsSync(todoDir)) fs.mkdirSync(todoDir, { recursive: true });
        fs.writeFileSync(path.join(todoDir, filename), missionContent);
        return json(res, { ok: true, id, filename });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 500);
      }
    }

    // POST /api/incidents/report — create an incident report
    if (req.method === "POST" && pathname === "/api/incidents/report") {
      const body = await readBody(req);
      try {
        const data = JSON.parse(body);
        if (!data.detail) {
          return json(res, { ok: false, error: "Detail required" }, 400);
        }
        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, "_").slice(0, 19) + "Z";
        const id = require("crypto").randomUUID().slice(0, 8);
        const agent = data.agent || "agent-generator";
        const filename = ts + "-" + agent + "-" + id + ".json";
        const incident = {
          type: data.type || "manual",
          agent,
          detail: data.detail,
          timestamp: now.toISOString(),
          source: "web-dashboard",
        };
        const incidentsDir = "/srv/dev/agents/_shared/incidents";
        if (!fs.existsSync(incidentsDir)) fs.mkdirSync(incidentsDir, { recursive: true });
        fs.writeFileSync(path.join(incidentsDir, filename), JSON.stringify(incident, null, 2));
        return json(res, { ok: true, filename });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 500);
      }
    }

    // GET /api/system-stats — system resource stats
    if (pathname === "/api/system-stats") {
      return json(res, getSystemStats());
    }

    // GET /api/mailbox — mailbox messages for a specific agent
    if (pathname === "/api/mailbox") {
      const agent = url.searchParams.get("agent") || "";
      const messages = getMailboxMessages();
      const filtered = agent ? messages.filter(m => m._recipient === agent || m.from === agent) : messages;
      return json(res, { messages: filtered, count: filtered.length });
    }

    // GET /api/mailbox/agents — list agents with mailboxes
    if (pathname === "/api/mailbox/agents") {
      const SHARED = "/srv/dev/agents/_shared";
      const mailboxDir = path.join(SHARED, "mailbox");
      const agents = [];
      if (fs.existsSync(mailboxDir)) {
        try {
          const entries = fs.readdirSync(mailboxDir, { withFileTypes: true })
            .filter(d => d.isDirectory());
          for (const d of entries) {
            const inboxDir = path.join(mailboxDir, d.name, "inbox");
            let count = 0;
            if (fs.existsSync(inboxDir)) {
              try { count = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json")).length; } catch {}
            }
            agents.push({ name: d.name, messages: count });
          }
        } catch {}
      }
      return json(res, { agents });
    }

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

  
  // GET /api/logs/stream/:source — SSE live log streaming
  if (pathname.startsWith("/api/logs/stream/")) {
    const source = pathname.replace("/api/logs/stream/", "");
    const logPaths = {
      "unified-server": path.join(AGENT_DIR, "logs", "unified-server.log"),
      "dispatcher": path.join(AGENT_DIR, "logs", "dispatcher.log"),
      "web-dashboard": path.join(AGENT_DIR, "logs", "web-dashboard.log"),
      "errors": path.join(AGENT_DIR, "logs", "errors.log"),
    };
    const logPath = logPaths[source];
    if (!logPath) {
      res.writeHead(400);
      return res.end("Unknown source");
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    let lastSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    const interval = setInterval(() => {
      try {
        const currentSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
        if (currentSize > lastSize) {
          const fd = fs.openSync(logPath, "r");
          const buf = Buffer.alloc(currentSize - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          fs.closeSync(fd);
          const newLines = buf.toString("utf8").split("\n").filter(Boolean);
          for (const line of newLines) {
            let cls = "";
            if (/error|fail|fatal|crash/i.test(line)) cls = "error";
            else if (/warn|warning/i.test(line)) cls = "warn";
            res.write('data: ' + JSON.stringify({ line, class: cls }) + '\n\n');
          }
          lastSize = currentSize;
        }
      } catch {}
    }, 1000);

    req.on("close", () => {
      clearInterval(interval);
    });
    return;
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

  
  // GET /generate — agent generation form
  if (pathname === "/generate") {
    const html = renderGenerateForm();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // GET /mission/new — mission creation form
  if (pathname === "/mission/new") {
    const html = renderMissionForm();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // GET /mailbox — inter-agent mailbox viewer
  if (pathname === "/mailbox") {
    const agentFilter = url.searchParams.get("agent") || "";
    const html = renderMailbox(agentFilter);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // GET /incidents — incident viewer
  if (pathname === "/incidents") {
    const html = renderIncidents();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

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
