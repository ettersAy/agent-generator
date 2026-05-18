# Telegram Messaging System — Explained

> **Purpose:** Deep technical walkthrough of how each AI agent sends and receives Telegram messages.  
> **Style:** Step-by-step code tracing with simple explanations. Every concept is paired with the exact code that makes it work.  
> **Covers:** The shared library (`telegram-agent-kit`), the generated agent, all shell tools, the full lifecycle of every command, error handling, recovery, process management, and agent generation.

---

## The Big Picture

There are **three layers** working together:

```
┌──────────────────────────────────────────────────────────────┐
│  LAYER 1 — Telegram Bot API                                  │
│  api.telegram.org/bot<TOKEN>                                 │
│  Telegram's servers. Each agent gets its own bot token.      │
└──────────────────────┬───────────────────────────────────────┘
                       │ HTTPS (polling)
┌──────────────────────┴───────────────────────────────────────┐
│  LAYER 2 — telegram-agent-kit (shared library)               │
│  /srv/dev/agents/telegram-agent-kit/                         │
│  One copy on disk. Every agent requires() it.                │
│  Contains all the real logic: polling, routing, spawning,    │
│  heartbeat monitoring, AI backends, mission management.      │
└──────────────────────┬───────────────────────────────────────┘
                       │ require()
┌──────────────────────┴───────────────────────────────────────┐
│  LAYER 3 — Generated Agent (thin wrapper)                    │
│  /srv/dev/agents/my-bot/                                     │
│  Each agent is just:                                          │
│    1. telegram-server.js (20 lines, instantiates the kit)    │
│    2. .env (bot token, chat ID, API keys)                    │
│    3. Shell scripts (start/stop/status/send/inbox)           │
│  Fully isolated — no shared state with other agents.         │
└──────────────────────────────────────────────────────────────┘
```

**Why this design?** You write the logic once in the shared kit. Each agent is just configuration + identity. When you fix a bug or add a feature, all agents get it. They all `require()` the same files from disk.

---

## Part 1: How Telegram Bot API Works

### 1.1 Polling (what we use)

Each agent **asks** Telegram "do you have messages for me?" in a continuous loop. This is called **long-polling**.

Here's exactly what happens in a single poll cycle:

**Step 1:** The agent sends an HTTP GET request:

```
GET https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates?offset=7&timeout=30
                                                                       │        │
                                                         "only give me      "wait up
                                                         updates with ID    to 30 seconds
                                                         7 or higher"       for an answer"
```

**Step 2:** Telegram holds the connection open. Two possible outcomes:

- **If no message arrives within 30 seconds:** Telegram responds with `{ ok: true, result: [] }` — an empty list.
- **If a message arrives during those 30 seconds:** Telegram responds immediately with `{ ok: true, result: [{ update_id: 8, message: { text: "/start", chat: { id: 123 }, from: { first_name: "Ayoub" } } }] }`

**Step 3:** The agent processes the response. If messages were returned, it saves the highest `update_id` (8 in this example) to disk.

**Step 4:** The next poll starts from `offset = 8 + 1 = 9`. This means message #8 is never fetched again.

**Step 5:** Repeat forever.

### 1.2 Why Polling (Not Webhooks)

Webhooks would mean Telegram **pushes** messages to the agent — but that requires the agent to have a **public HTTPS URL** accessible from the internet. These agents run on a local/VPS server behind a firewall. No public URL exists.

Polling works from **behind any network** because it's an **outgoing** connection. The agent reaches out to Telegram, not the other way around. This is the only option that works everywhere.

### 1.3 The Poll Loop in Code

`telegram-agent-kit/index.js:304-307`:

```js
this.running = true;
this.log("Polling for messages...");
while (this.running) {
  await this.poll();     // ← each iteration is one getUpdates call
}
this.log("Server stopped");
```

This is an **infinite loop**. The only way out is setting `this.running = false`, which happens on SIGINT/SIGTERM. Between `poll()` calls there's almost no gap — the server is in one of two states: waiting for Telegram's response (up to 30 seconds), or processing a message (milliseconds to seconds).

### 1.4 The `getUpdates` Mechanism

`telegram-client.js:88-94`:

```js
async getUpdates(offset, timeout = 30) {
  return this.apiGet("getUpdates", {
    offset: String(offset),               // "only give me updates ≥ this ID"
    timeout: String(timeout),             // "wait up to this many seconds"
    allowed_updates: JSON.stringify(["message"]),  // "only message-type updates"
  });
}
```

The `offset` parameter is the key. Telegram only returns updates where `update_id >= offset`. Once we've processed an update, we save its ID + 1 as the next offset. This guarantees we never get the same message twice (under normal operation).

---

## Part 2: The Shared Library — `telegram-agent-kit`

This is where all the real code lives. Every module is a single file, each with one clear responsibility.

### 2.1 `config.js` — Configuration Loader

**What it does:** Reads the agent's `.env` file, parses it, and returns a structured config object with all derived paths.

**The code** (`config.js:28-58`):

```js
function makeConfig(agentDir) {
  const env = loadEnv(path.join(agentDir, ".env"));  // read .env into { KEY: "value" }

  return {
    AGENT_DIR: agentDir,
    TG_TOKEN: env.TELEGRAM_BOT_TOKEN || "",           // the bot token
    CHAT_ID: env.TELEGRAM_CHAT_ID || "",              // where to send replies
    CLAUDE_BUDGET: env.CLAUDE_MAX_BUDGET || "2.00",   // max $ per mission

    // DeepSeek API (Anthropic-compatible endpoint)
    DS_API_KEY: env.ANTHROPIC_AUTH_TOKEN || "",
    DS_BASE: (env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, ""),
    DS_API_URL: ...,  // constructed from DS_BASE + "/v1/messages"
    DS_MODEL: "deepseek-chat",

    // File paths (all inside the agent's directory)
    STATE_FILE: path.join(agentDir, ".telegram-last-update"),   // last processed update_id
    PID_FILE: path.join(agentDir, ".telegram-server.pid"),       // process ID
    LOG_FILE: path.join(agentDir, "logs", "telegram.log"),       // server output
    INBOX_FILE: path.join(agentDir, "logs", "messages.jsonl"),   // incoming messages
    ERROR_LOG: path.join(agentDir, "logs", "errors.log"),        // structured errors

    // Mission directories
    M_TODO: path.join(agentDir, "missions", "todo"),
    M_PROGRESS: path.join(agentDir, "missions", "in-progress"),
    M_DONE: path.join(agentDir, "missions", "done"),
    M_FAILED: path.join(agentDir, "missions", "failed"),
    M_RESULTS: path.join(agentDir, "missions", "results"),
  };
}
```

**How `loadEnv` works** (`config.js:15-24`):

```js
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  fs.readFileSync(filePath, "utf8").split("\n").forEach((l) => {
    const t = l.trim();
    if (!t || t.startsWith("#")) return;           // skip empty lines and comments
    const i = t.indexOf("=");                      // find first =
    if (i === -1) return;                          // skip lines without =
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();  // KEY → value
  });
  return env;
}
```

Simple hand-written parser. No npm dependencies. Reads a file like:

```
TELEGRAM_BOT_TOKEN=123456:ABCdef
TELEGRAM_CHAT_ID=987654321
```

And turns it into `{ TELEGRAM_BOT_TOKEN: "123456:ABCdef", TELEGRAM_CHAT_ID: "987654321" }`.

**Every path is deterministic.** Given an agent directory, all paths are derived. No guesswork, no environment-specific configuration beyond `.env`.

---

### 2.2 `telegram-client.js` — Bot API HTTP Client

**What it does:** Wraps the Telegram Bot API in plain Node.js `https`. Zero dependencies.

#### 2.2.1 Sending a Message

`telegram-client.js:52-65`:

```js
async sendMessage(chatId, text, opts = {}) {
  // Truncate if longer than 3900 chars (Telegram limit is 4096, leave room)
  const t = text.length > this.MAX_MSG
    ? text.slice(0, this.MAX_MSG - 3) + "..."
    : text;

  return this._httpReq(
    {
      hostname: "api.telegram.org",
      path: `/bot${this.botToken}/sendMessage`,        // ← the API endpoint
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    { chat_id: chatId, text: t, parse_mode: "HTML", ...opts }   // ← the body
  );
}
```

This sends:

```
POST https://api.telegram.org/bot<TOKEN>/sendMessage
Content-Type: application/json

{
  "chat_id": 987654321,
  "text": "Mission starting...",
  "parse_mode": "HTML"
}
```

HTML parse mode means you can use `<b>bold</b>`, `<i>italic</i>`, `<code>monospace</code>`.

#### 2.2.2 Editing a Message (for live progress)

`telegram-client.js:68-82`:

```js
async editMessage(chatId, messageId, text) {
  const t = text.length > this.MAX_MSG
    ? text.slice(0, this.MAX_MSG - 3) + "..."
    : text;

  return this._httpReq(
    {
      hostname: "api.telegram.org",
      path: `/bot${this.botToken}/editMessageText`,    // ← different endpoint
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    { chat_id: chatId, message_id: messageId, text: t }
  );
}
```

This is the key to live heartbeat updates. Instead of sending a new message every 60 seconds, the agent **edits the existing message** in place. The message stays at the same position in the chat, but its content updates. The user sees the elapsed time and heartbeat count incrementing.

#### 2.2.3 Getting Updates (the poll)

`telegram-client.js:88-94`:

```js
async getUpdates(offset, timeout = 30) {
  return this.apiGet("getUpdates", {
    offset: String(offset),
    timeout: String(timeout),
    allowed_updates: JSON.stringify(["message"]),
  });
}
```

`apiGet` builds a URL with query parameters and does an HTTPS GET:

```
GET https://api.telegram.org/bot<TOKEN>/getUpdates?offset=8&timeout=30&allowed_updates=%5B%22message%22%5D
```

#### 2.2.4 The HTTP Layer

`telegram-client.js:6-29` — `_httpReq` is the foundation method used by `sendMessage` and `editMessage`:

```js
_httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));                  // accumulate response
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(d) });  // parse JSON
        } catch {
          resolve({ status: res.statusCode, body: d });              // raw on failure
        }
      });
    });
    r.on("error", reject);                    // network error → reject
    if (body) r.write(JSON.stringify(body));  // write POST body if present
    r.end();                                  // send the request
  });
}
```

**No retry, no exponential backoff.** If the request fails, the error propagates to the caller. The poll loop's try/catch handles it (counts consecutive errors, exits after 10).

---

### 2.3 `message-store.js` — Inbox Persistence

**What it does:** Stores every incoming message to disk and tracks the last-seen update ID.

#### 2.3.1 Where Things Live

Two files on disk:

- `.telegram-last-update` — a plain integer, like `42`. The highest `update_id` ever processed.
- `logs/messages.jsonl` — one JSON object per line, one per incoming message.

#### 2.3.2 Storing a Message

`message-store.js:25-28`:

```js
storeMsg(data) {
  ensureDir(path.dirname(this.inboxFile));
  fs.appendFileSync(this.inboxFile, JSON.stringify(data) + "\n");
}
```

Simple append to a JSONL file. One line per message:

```json
{"update_id":8,"from":"Ayoub","username":"ettersAy","chat_id":123,"text":"/start","timestamp":"2026-05-16T12:34:56.000Z","replied":false}
```

#### 2.3.3 Marking a Message as Replied

`message-store.js:30-49`:

```js
markReplied(updateId) {
  const lines = fs.readFileSync(this.inboxFile, "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => {
      const o = JSON.parse(l);
      if (o.update_id === updateId) o.replied = true;   // flip the flag
      return JSON.stringify(o);
    });
  fs.writeFileSync(this.inboxFile, lines.join("\n") + "\n");   // rewrite entire file
}
```

**The tradeoff:** This rewrites the **entire file** every time a message is replied to. For a single-user bot receiving ~50 messages/day, this is a few kilobytes — negligible. For 10,000+ messages/day, this would need a database. Keep it simple until you can't.

#### 2.3.4 Tracking the Last Update

```js
loadLastUpdate() {
  try {
    return parseInt(fs.readFileSync(this.stateFile, "utf8"), 10) || 0;
  } catch {
    return 0;     // no file → start from the beginning
  }
}

saveLastUpdate(id) {
  fs.writeFileSync(this.stateFile, String(id));
}
```

Reads/writes a single integer to `.telegram-last-update`. If the file doesn't exist (first run), returns 0 — which means "give me all updates since the beginning of time." Telegram responds with the most recent ones only.

---

### 2.4 `mission-manager.js` — Mission Ticket CRUD

**What it does:** Manages the full lifecycle of a `/mission` task, from creation to completion. All mission state is just files on disk.

#### 2.4.1 Creating a Mission

`mission-manager.js:23-35`:

```js
create(userMsg) {
  ensureDir(this.dirs.todo);                       // make sure todo/ exists
  const { filename } = this.nextSlug(userMsg);      // generate filename
  const fp = path.join(this.dirs.todo, filename);   // full path

  fs.writeFileSync(fp,
    `# Mission: ${userMsg.slice(0, 80)}\n\n` +
    `| Field | Detail |\n|-------|--------|\n` +
    `| **Created** | ${ts()} |\n` +
    `| **Status** | todo |\n` +
    `| **Source** | Telegram |\n` +
    `| **PID** | - |\n\n` +
    `## Original Request\n\n${userMsg}\n\n` +
    `## Progress Log\n\n` +
    `| Timestamp | Event | Detail |\n|-----------|-------|--------|\n`
  );

  return fp;    // return the path so the caller can move/update it
}
```

This creates a file that looks like:

```markdown
# Mission: fix the login bug on the signup page

| Field | Detail |
|-------|--------|
| **Created** | 2026-05-16T12:34:56.000Z |
| **Status** | todo |
| **Source** | Telegram |
| **PID** | - |

## Original Request

fix the login bug on the signup page

## Progress Log

| Timestamp | Event | Detail |
|-----------|-------|--------|
```

#### 2.4.2 File Naming

`mission-manager.js:12-21`:

```js
nextSlug(userMsg) {
  const d = new Date().toISOString().slice(0, 10);    // "2026-05-16"
  const seq = String(Date.now()).slice(-4);             // last 4 digits of epoch ms
  const slug = userMsg
    .slice(0, 40)                                       // first 40 chars
    .replace(/[^a-zA-Z0-9\s-]/g, "")                    // strip special chars
    .replace(/\s+/g, "-")                                // spaces → hyphens
    .toLowerCase();                                      // all lowercase
  return { dir: d, seq, slug, filename: `${d}-${seq}-${slug}.md` };
}
```

Example: `"/mission fix the login bug!!"` becomes `2026-05-16-7890-fix-the-login-bug.md`.

The `seq` (last 4 digits of epoch milliseconds) makes collisions extremely unlikely for a single-user bot.

#### 2.4.3 Moving Between Directories

`mission-manager.js:37-42`:

```js
move(fp, destDir) {
  const dest = path.join(destDir, path.basename(fp));
  ensureDir(destDir);
  fs.renameSync(fp, dest);     // atomic on the same filesystem
  return dest;
}
```

The mission travels:

```
missions/todo/2026-05-16-7890-fix-login.md     →  (created here)
missions/in-progress/2026-05-16-7890-fix-login.md  →  (moved here when started)
missions/done/2026-05-16-7890-fix-login.md     →  (moved here when complete)
                              ... OR ...
missions/failed/2026-05-16-7890-fix-login.md   →  (moved here if it goes wrong)
```

#### 2.4.4 Appending to the Progress Log

`mission-manager.js:44-53`:

```js
appendLog(fp, event, detail) {
  let c = fs.readFileSync(fp, "utf8");
  // Insert a new row just after the table header
  c = c.replace(
    "|-----------|-------|--------|",
    `|-----------|-------|--------|\n| ${ts()} | ${event} | ${detail} |`
  );
  fs.writeFileSync(fp, c);
}
```

This finds the table header separator and inserts a new row right after it. After a few events, the progress log looks like:

```markdown
| Timestamp | Event | Detail |
|-----------|-------|--------|
| 2026-05-16T12:40:00.000Z | completed | Result 1234 chars, 320s |
| 2026-05-16T12:35:00.000Z | claude_spawned | PID 12345 |
| 2026-05-16T12:34:56.000Z | started | Starting Claude worker |
```

Newest events are at the top (inserted just after the header).

#### 2.4.5 Updating Metadata

`mission-manager.js:55-66`:

```js
updateMeta(fp, updates) {
  let c = fs.readFileSync(fp, "utf8");
  for (const [key, val] of Object.entries(updates)) {
    if (key === "Status")
      c = c.replace(/\| \*\*Status\*\* \| .* \|/, `| **Status** | ${val} |`);
    if (key === "PID")
      c = c.replace(/\| \*\*PID\*\* \| .* \|/, `| **PID** | ${val} |`);
  }
  fs.writeFileSync(fp, c);
}
```

Regex-based find-and-replace on the metadata table. Only `Status` and `PID` are supported — the file format is simple enough that regex works reliably.

#### 2.4.6 Reading Results

`mission-manager.js:76-89`:

```js
getResultPath(missionFile) {
  // mission:    missions/in-progress/2026-05-16-7890-fix-login.md
  // result:     missions/results/2026-05-16-7890-fix-login_result.md
  return path.join(
    this.dirs.results,
    path.basename(missionFile).replace(".md", "_result.md")
  );
}

getResultContent(missionFile) {
  const rp = this.getResultPath(missionFile);
  try {
    if (fs.existsSync(rp)) return fs.readFileSync(rp, "utf8").trim();
  } catch {}
  return "";
}
```

The result file is written by the Claude child process's stdout capture. Everything Claude outputs goes here. When the heartbeat monitor detects the process has exited, it reads this file and sends the content to the user via Telegram.

---

### 2.5 `claude-worker.js` — Claude CLI Spawn + Heartbeat Monitor

This is the most complex module. It does three things:
1. Spawns `claude` as a child process
2. Monitors it with a heartbeat
3. Recovers monitors after a server restart

#### 2.5.1 Spawning Claude

`claude-worker.js:130-178`:

```js
async spawn(userMessage, missionFile, chatId, cwd) {
  const resultFile = this.missions.getResultPath(missionFile);
  fs.writeFileSync(resultFile, "");           // create empty result file

  const child = spawn("claude", [
    "-p", userMessage,                         // the mission description
    "--output-format", "text",                 // plain text output (not JSON)
    "--dangerously-skip-permissions",           // auto-approve everything
    "--no-session-persistence",                 // don't remember previous missions
  ], {
    cwd,                                        // working directory = agent root
    stdio: ["ignore", "pipe", "pipe"],          // stdin=ignore, stdout=pipe, stderr=pipe
    env: { ...process.env },                    // inherit environment variables
  });

  // ── Capture stdout ──────────────────────────────────
  let stdout = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();                     // accumulate all output
  });

  // ── Capture stderr ──────────────────────────────────
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // ── On process exit, write everything to the result file ──
  child.on("close", (code, signal) => {
    const output = stdout.trim();
    const errOutput = stderr.trim();
    const content = output || "(no output)";
    fs.writeFileSync(
      resultFile,
      errOutput ? content + "\n\n--- stderr ---\n" + errOutput : content
    );
  });

  // ── On spawn error, write error to result file ──
  child.on("error", (err) => {
    fs.writeFileSync(resultFile, `SPAWN ERROR: ${err.message}`);
  });

  return child.pid;     // return PID so the heartbeat monitor can track it
}
```

**What `--dangerously-skip-permissions` means:** Normally, Claude CLI asks for permission before editing files, running commands, or making network requests. This flag skips all prompts — Claude operates autonomously. This is the "agent mode" that makes `/mission` powerful. Without it, the user would need to approve every edit via Telegram, which defeats the purpose.

**Why `--no-session-persistence`:** Each mission starts fresh. Claude doesn't remember previous missions. This keeps missions independent and avoids context pollution.

**The command that actually runs:**

```bash
claude -p "fix the login bug on the signup page" \
       --output-format text \
       --dangerously-skip-permissions \
       --no-session-persistence
```

#### 2.5.2 The Heartbeat Monitor

`claude-worker.js:30-128`:

```js
async startMonitor(missionFile, chatId, pid) {
  const resultFile = this.missions.getResultPath(missionFile);
  const startTime = Date.now();

  // ── Step 1: Send initial progress message ────────────
  let progressMsgId = null;
  try {
    const resp = await this.tg.sendMessage(chatId, this.getProgressText(0, 0));
    progressMsgId = resp.body?.result?.message_id;   // capture the message ID
  } catch {}

  // ── Step 2: Create monitor object ────────────────────
  const monitor = {
    missionFile, chatId, pid, startTime,
    progressMsgId, heartbeatCount: 0, active: true,
  };
  this.activeMonitors.push(monitor);

  // ── Step 3: Define the tick function ─────────────────
  const tick = async () => {
    if (!monitor.active) return;                      // stopped

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    monitor.heartbeatCount++;

    // Check if process is alive
    let alive = false;
    try { process.kill(pid, 0); alive = true; }       // signal 0 = test existence
    catch { alive = false; }

    if (alive) {
      // ── Process still running → update the progress message ──
      if (monitor.progressMsgId) {
        try {
          await this.tg.editMessage(
            chatId, monitor.progressMsgId,
            this.getProgressText(elapsed, monitor.heartbeatCount)
          );
        } catch {
          // Edit failed (maybe message deleted) → create a new one
          const resp = await this.tg.sendMessage(
            chatId,
            this.getProgressText(elapsed, monitor.heartbeatCount)
          );
          monitor.progressMsgId = resp.body?.result?.message_id;
        }
      }
      monitor._timer = setTimeout(tick, MONITOR_INTERVAL_MS);  // schedule next tick
    } else {
      // ── Process exited → read result and notify ──────
      const resultText = this.missions.getResultContent(missionFile);

      if (resultText) {
        await this.tg.sendMessage(chatId,
          `<b>Mission complete</b> (${Math.floor(elapsed/60)}m ${elapsed%60}s)\n\n${resultText.slice(0, 3800)}`
        );
        this.missions.appendLog(missionFile, "completed", `Result ${resultText.length} chars, ${elapsed}s`);
        this.missions.updateMeta(missionFile, { Status: "completed" });
        this.missions.move(missionFile, this.missions.dirs.done);
      } else {
        await this.tg.sendMessage(chatId, `Mission process exited with no result. Check logs.`);
        this.missions.appendLog(missionFile, "failed", "Process exited with no result");
        this.missions.updateMeta(missionFile, { Status: "failed" });
        this.missions.move(missionFile, this.missions.dirs.failed);
      }

      // Remove from active monitors
      const idx = this.activeMonitors.indexOf(monitor);
      if (idx >= 0) this.activeMonitors.splice(idx, 1);
    }
  };

  // ── Step 4: Schedule the first tick ──────────────────
  monitor._timer = setTimeout(tick, MONITOR_INTERVAL_MS);   // 60 seconds
}
```

The monitor sends **one Telegram message** and keeps editing it. The message cycles through three variants:

```js
getProgressText(elapsedSec, heartbeatCount) {
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  return [
    `<b>Mission in progress</b>`,
    `Elapsed: ${minutes}m ${seconds}s | Heartbeats: ${heartbeatCount}`,
    ``,
    heartbeatCount % 3 === 0 ? `Claude is reasoning deeply.` :
    heartbeatCount % 3 === 1 ? `Still running — process alive.` :
                               `Continuing execution.`,
  ].join("\n");
}
```

Every minute, the message updates:
- The elapsed time ticks up
- The heartbeat count increments
- The status line rotates through 3 phrases (just to show the message is live, not stuck)

#### 2.5.3 Recovery on Restart

`claude-worker.js:182-209`:

```js
async recoverMonitors(chatId) {
  const files = this.missions.getInProgress();      // list missions/in-progress/*.md
  if (files.length === 0) return;

  for (const f of files) {
    const fp = path.join(this.missions.dirs.inProgress, f);
    const content = fs.readFileSync(fp, "utf8");

    // Extract PID from the mission file's metadata table
    const pidMatch = content.match(/\| \*\*PID\*\* \| (\d+) \|/);
    if (pidMatch) {
      const pid = parseInt(pidMatch[1]);

      // Check if the process is still alive
      let alive = false;
      try { process.kill(pid, 0); alive = true; }
      catch { alive = false; }

      if (alive && chatId) {
        this.log(`Resuming monitor for PID ${pid}`);
        await this.startMonitor(fp, chatId, pid);     // reattach heartbeat
      } else {
        this.log(`PID ${pid} dead — moving to failed`);
        this.missions.move(fp, this.missions.dirs.failed);  // mark as failed
      }
    }
  }
}
```

This runs once at server startup. It reads all `missions/in-progress/*.md` files, extracts the PID from each, and checks if the process is still alive. If yes → resume monitoring. If no → mark as failed.

**This means:** If the server crashes and restarts while Claude is running a mission, the mission continues. The Claude process keeps running (it's a separate OS process, not tied to the Node.js server). After restart, the server reconnects its heartbeat monitor to the surviving Claude process. The user gets notified that the mission completed.

---

### 2.6 `ai-backends.js` — AI API Clients

**What it does:** Provides three tiers of AI backends for quick answers (not `/mission` — that uses Claude CLI directly).

#### 2.6.1 Tier 1: Direct HTTPS (Fast Path)

`ai-backends.js:13-76` — `callDeepSeek()`:

```js
async callDeepSeek(prompt, options = {}) {
  const { maxTokens = 1024, system, timeout = 30000 } = options;

  const body = JSON.stringify({
    model: "deepseek-chat",
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: prompt }],
  });

  // Raw HTTPS request — no SDK
  const req = https.request(DS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": DS_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    timeout,
  }, (res) => {
    // Parse response, extract text from content array
  });

  req.write(body);
  req.end();
}
```

Used for: quick replies to non-command text (the default handler).

#### 2.6.2 Tier 2: Anthropic SDK (Rich Path)

`ai-backends.js:79-118` — `callDeepSeekSDK()`:

```js
async callDeepSeekSDK(prompt, options = {}) {
  const Anthropic = require("@anthropic-ai/sdk");    // lazy-loaded

  if (!this._sdk) {
    this._sdk = new Anthropic({
      apiKey: DS_API_KEY,
      baseURL: DS_BASE,
    });
  }

  const msg = await this._sdk.messages.create({
    model: "deepseek-chat",
    max_tokens: 4096,
    system: "You are MyBot. Provide detailed, thorough responses.",
    messages: [{ role: "user", content: prompt }],
  }, { timeout: 60000 });

  return extractText(msg.content);
}
```

Used for: `/externalllm` command. Lazy-loads the SDK so it's only required if actually used.

#### 2.6.3 Tier 3: Claude CLI Sync (Fallback)

`ai-backends.js:121-142` — `spawnClaudeSync()`:

```js
spawnClaudeSync(prompt, budget, timeoutMs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [
      "-p", prompt,
      "--output-format", "text",
      "--no-session-persistence",
      ...(budget ? ["--max-budget-usd", budget] : []),
    ], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim() || "(no response)"));
    child.on("error", reject);
  });
}
```

Used when both API backends fail. This is the synchronous version — it waits for Claude to finish, then returns the text. Unlike `/mission`, there's no heartbeat monitor. The user just sees "... processing ..." and then gets the reply.

---

### 2.7 `index.js` — AgentServer (The Orchestrator)

This is the main class. Every agent creates one `AgentServer` instance.

#### 2.7.1 Constructor

`index.js:26-56`:

```js
constructor(agentDir, options = {}) {
  // Load configuration from .env
  this.config = makeConfig(agentDir);

  // Store identity
  this.agentDisplayName = options.agentDisplayName || "Agent";
  this.projectName = options.projectName || "Project";
  this.roleDescription = options.roleDescription || "AI dev agent";

  // Instantiate all services
  this.tg = new TelegramClient(this.config.TG_TOKEN);
  this.store = new MessageStore(this.config.INBOX_FILE, this.config.STATE_FILE);
  this.missions = new MissionManager({ ... });
  this.ai = new AiBackends(this.config, this.log.bind(this));
  this.claude = new ClaudeWorker(this.tg, this.missions, this.log.bind(this), this.logError.bind(this));

  this.running = false;
  this.consErrors = 0;           // consecutive error counter
  this.genSessions = {};         // interactive generation sessions
}
```

Each service gets exactly what it needs, nothing more. The constructor is pure wiring — no logic.

#### 2.7.2 The Poll Loop

`index.js:231-255`:

```js
async poll() {
  const offset = this.store.loadLastUpdate() + 1;    // start after last seen

  try {
    const resp = await this.tg.getUpdates(offset);    // wait up to 30 seconds

    if (!resp.ok) {
      this.consErrors++;
      if (this.consErrors >= 10) {
        this.logError("FATAL", "Too many tg errors");
        process.exit(1);                             // give up after 10 consecutive failures
      }
      return;                                         // skip this cycle
    }

    this.consErrors = 0;                              // reset error counter on success

    for (const u of resp.result || []) {
      if (u.update_id > this.store.loadLastUpdate()) {
        this.store.saveLastUpdate(u.update_id);       // mark as processed
        await this.processUpdate(u);                  // handle the message
      }
    }
  } catch (err) {
    this.consErrors++;
    this.logError("ERROR", `Poll err (${this.consErrors})`, err.message);
    if (this.consErrors >= 10) process.exit(1);
  }
}
```

**Key behaviors:**
- **Sequential processing:** Each update is `await`ed before the next. Message #2 waits for message #1's processing to finish. For a single-user bot, this is fine — messages arrive seconds apart.
- **Error counting:** 10 consecutive poll errors = server gives up and exits. The shell script (or systemd) should restart it.
- **Offset guard:** `if (u.update_id > this.store.loadLastUpdate())` prevents duplicate processing.

#### 2.7.3 Message Routing

`index.js:154-228` — `processUpdate()`:

```js
async processUpdate(update) {
  const msg = update.message;
  if (!msg) return;                                          // non-message update, skip

  const fromName = msg.from?.first_name || "Unknown";
  const text = msg.text || "";
  const chatId = msg.chat?.id;
  const updateId = update.update_id;
  if (!text || !chatId) return;                             // empty or no chat, skip

  // ── Step 1: Log the message ───────────────────────────
  this.log(`[${fromName}] ${text.slice(0, 100)}`);

  // ── Step 2: Persist to inbox ──────────────────────────
  this.store.storeMsg({
    update_id: updateId,
    from: fromName,
    username: msg.from?.username || "",
    chat_id: chatId,
    text,
    timestamp: ts(),
    replied: false,
  });

  // ── Step 3: Check chat ID detection ───────────────────
  if (!this.config.CHAT_ID && chatId) {
    this.log(`Detected chat ID: ${chatId}`);
  }

  // ── Step 4: Check for active generation session ───────
  if (this.genSessions[chatId]) {
    if (this.customCommands._continueGenSession) {
      await this.customCommands._continueGenSession(chatId, text, updateId);
    }
    return;
  }

  const cleanText = text.trim();

  // ── Step 5: Route by command ──────────────────────────

  // /start
  if (/^\/start$/i.test(cleanText)) {
    return await this.handleStart(chatId, updateId);
  }

  // Custom commands (defined by the agent)
  for (const [pattern, handler] of Object.entries(this.customCommands)) {
    if (pattern.startsWith("_")) continue;                    // skip internal helpers
    const match = cleanText.match(new RegExp(pattern, "i"));
    if (match) {
      const args = cleanText.slice(match[0].length).trim();
      await handler.call(this, chatId, args, updateId, match);
      this.store.markReplied(updateId);
      return;
    }
  }

  // /mission <task>
  const missionMatch = cleanText.match(/^\/mission\b\s*/i);
  if (missionMatch) {
    const taskText = cleanText.slice(missionMatch[0].length).trim() || "(no instructions)";
    await this.handleMission(chatId, taskText, updateId);
  }

  // /externalllm <query>
  else if (/^\/externalllm\b\s*/i.test(cleanText)) {
    const llmText = cleanText.replace(/^\/externalllm\b\s*/i, "").trim();
    if (!llmText) {
      await this.tg.sendMessage(chatId, "Add a query after <b>/externalllm</b>.");
      this.store.markReplied(updateId);
      return;
    }
    await this.handleExternalLlm(chatId, llmText);
  }

  // Custom onMessage handler (for non-command text)
  else if (this.onMessage) {
    await this.onMessage.call(this, chatId, cleanText, updateId);
  }

  // Default: quick AI answer
  else {
    await this.handleDefault(chatId, cleanText);
  }

  this.store.markReplied(updateId);
}
```

**The routing decision tree:**

```
Incoming message
  │
  ├─ Empty text or no chat? → discard
  │
  ├─ Active generation session? → route to _continueGenSession
  │
  ├─ Exactly "/start"? → handleStart()
  │
  ├─ Matches a custom command pattern? → custom handler
  │
  ├─ Starts with "/mission"? → handleMission()
  │
  ├─ Starts with "/externalllm"? → handleExternalLlm()
  │
  ├─ onMessage handler defined? → custom handler
  │
  └─ None of the above → handleDefault()
```

#### 2.7.4 Command Handlers

**`/start` — Welcome message:**

```js
async handleStart(chatId, updateId) {
  await this.tg.sendMessage(chatId,
    `<b>${this.agentDisplayName}</b> — ${this.roleDescription}\n\n` +
    `<b>Commands:</b>\n` +
    `<b>/mission</b> <task> — Full Claude CLI mission\n` +
    `<b>/externalllm</b> <query> — DeepSeek API\n` +
    `<b>Any text</b> — Quick AI answer`
  );
  this.store.markReplied(updateId);
}
```

**`/mission <task>` — Full mission (see Part 4 for the complete flow):**

```js
async handleMission(chatId, taskText, updateId) {
  const missionFile = this.missions.create(taskText);
  this.missions.updateMeta(missionFile, { Status: "in-progress" });
  const inProgressFile = this.missions.move(missionFile, this.config.M_PROGRESS);
  this.missions.appendLog(inProgressFile, "started", "Starting Claude worker");

  await this.tg.sendMessage(chatId,
    `<b>Mission starting</b>\n${taskText.slice(0, 80)}...\nClaude CLI (no limits).`
  );

  const pid = await this.claude.spawn(taskText, inProgressFile, chatId, this.config.AGENT_DIR);
  this.missions.updateMeta(inProgressFile, { PID: String(pid) });
  this.missions.appendLog(inProgressFile, "claude_spawned", `PID ${pid}`);
  await this.claude.startMonitor(inProgressFile, chatId, pid);
}
```

**`/externalllm <query>` — DeepSeek SDK call:**

```js
async handleExternalLlm(chatId, llmText) {
  await this.tg.sendMessage(chatId, "Calling DeepSeek API...");
  try {
    const response = await this.ai.callDeepSeekSDK(llmText, {
      maxTokens: 4096, timeout: 60000,
      system: `You are ${this.agentDisplayName}. Provide detailed, thorough responses.`,
    });
    await this.tg.sendMessage(chatId, response);
  } catch (err) {
    this.logError("ERROR", "SDK call failed", err.message);
    await this.tg.sendMessage(chatId, `SDK error: ${err.message}`);
  }
}
```

**Default (any non-command text) — Quick AI answer:**

```js
async handleDefault(chatId, cleanText) {
  await this.tg.sendMessage(chatId, "Processing...");
  try {
    // Try DeepSeek API first (fast)
    const response = await this.ai.callDeepSeek(cleanText, {
      maxTokens: 1024, timeout: 30000,
      system: `You are ${this.agentDisplayName}, a concise AI assistant. Keep responses brief.`,
    });
    await this.tg.sendMessage(chatId, response);
  } catch (err) {
    // Fall back to Claude CLI sync (slower but more capable)
    this.logError("ERROR", "Fast API failed, falling back to Claude CLI", err.message);
    try {
      await this.tg.sendMessage(chatId, "API unavailable, switching to Claude CLI...");
      const response = await this.ai.spawnClaudeSync(cleanText, "0.50", 120000, this.config.AGENT_DIR);
      await this.tg.sendMessage(chatId, response);
    } catch (err2) {
      this.logError("ERROR", "All backends failed", err2.message);
      await this.tg.sendMessage(chatId, "All AI backends unavailable.");
    }
  }
}
```

#### 2.7.5 Server Lifecycle

**`start()` — Full startup sequence** (`index.js:258-309`):

```js
async start() {
  // 1. Create all directories
  for (const d of [logs dir, missions/todo, missions/in-progress, missions/done, missions/failed, missions/results]) {
    ensureDir(d);
  }

  // 2. Write PID file
  fs.writeFileSync(this.config.PID_FILE, String(process.pid));

  // 3. Verify Telegram bot token
  const me = await this.tg.getMe();
  if (!me.ok) {
    this.logError("FATAL", "Invalid bot token");
    process.exit(1);
  }
  this.log(`Connected as @${me.result.username} (${me.result.first_name})`);

  // 4. Recover any in-progress missions
  await this.claude.recoverMonitors(this.config.CHAT_ID);

  // 5. Send startup notification
  if (this.config.CHAT_ID) {
    await this.tg.sendMessage(this.config.CHAT_ID,
      `${this.agentDisplayName} online.\nNo hard timeout — long missions supported.\nHeartbeats edit one message.`
    );
  }

  // 6. Enter polling loop
  this.running = true;
  while (this.running) {
    await this.poll();
  }
}
```

**`stop()`** just sets `this.running = false`, which unwinds the polling loop.

---

## Part 3: The Generated Agent

When `generate-agent.sh` runs, it takes templates from `templates/` and produces a complete agent. Let's walk through every file that gets created.

### 3.1 The Process: `generate-agent.sh`

`tools/lib/generate.sh:57-113` — `generate_agent()`:

```bash
generate_agent() {
  # 1. Create all directories
  mkdir -p "$AGENT_DIR"/{logs,missions/{todo,in-progress,done,failed,results},knowledge,sandbox}

  # 2. For each template file:
  for mapping in "${TEMPLATE_MAP[@]}"; do
    IFS='|' read -r tmpl out <<< "$mapping"
    # Read the template, substitute {{PLACEHOLDER}} values, write output
    substitute "$(cat "$TEMPLATES_DIR/$tmpl")" > "$AGENT_DIR/$out"
    # Make scripts executable
    if [[ "$out" == scripts/* ]] || [[ "$out" == tools/*.sh ]]; then
      chmod +x "$output_file"
    fi
  done

  # 3. Create .gitignore
  # 4. Touch empty log files
  # 5. Run npm install
}
```

The `substitute()` function (`tools/lib/generate.sh:27-45`) does pure bash string replacement:

```bash
substitute() {
  local content="$1"
  content="${content//"{{AGENT_NAME}}"/$AGENT_NAME}"             # my-bot
  content="${content//"{{AGENT_DISPLAY_NAME}}"/$AGENT_DISPLAY_NAME}"  # MyBot
  content="${content//"{{AGENT_DIR}}"/$AGENT_DIR}"                # /srv/dev/agents/my-bot
  content="${content//"{{TELEGRAM_BOT_TOKEN}}"/$TELEGRAM_BOT_TOKEN}" # 123:abc
  # ... 14 placeholders total
  echo "$content"
}
```

No templating library — just bash string replacement. It works because the placeholders are unique and never appear in real code.

### 3.2 `tools/telegram-server.js` — The Thin Wrapper

The entire agent server, in full:

```js
#!/usr/bin/env node
const { AgentServer } = require("/srv/dev/agents/telegram-agent-kit");

const AGENT_DIR = "{{AGENT_DIR}}";   // becomes "/srv/dev/agents/my-bot"

const server = new AgentServer(AGENT_DIR, {
  agentDisplayName: "{{AGENT_DISPLAY_NAME}}",   // "MyBot"
  projectName: "{{PROJECT_NAME}}",               // "MyProject"
  roleDescription: "{{AGENT_ROLE}}",             // "AI dev agent for MyProject"
});

process.on("SIGINT", () => { server.stop(); server.log("SIGINT"); });
process.on("SIGTERM", () => { server.stop(); server.log("SIGTERM"); });

server.start();
```

That's it. 20 lines. All real logic is in the shared kit.

### 3.3 `.env` — Agent Configuration

```bash
TELEGRAM_BOT_TOKEN=123456:ABCdef...
TELEGRAM_CHAT_ID=987654321
ANTHROPIC_AUTH_TOKEN=sk-...
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
CLAUDE_MAX_BUDGET=2.00
```

Each agent has its own bot token (created via [@BotFather](https://t.me/BotFather) on Telegram). No two agents share a token.

### 3.4 Shell Scripts: Process Management

#### `scripts/telegram-start.sh` — Start the Server

```bash
#!/usr/bin/env zsh
set -e

PID_FILE="$AGENT_DIR/.telegram-server.pid"
SERVER_SCRIPT="$AGENT_DIR/tools/telegram-server.js"
LOG_FILE="$AGENT_DIR/logs/telegram.log"

# 1. Check if already running
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Telegram server already running (PID: $PID)"
    exit 0                    # already running, nothing to do
  else
    echo "Stale PID file found (PID $PID is gone), cleaning up"
    rm -f "$PID_FILE"         # PID file references dead process, clean up
  fi
fi

# 2. Create log directory
mkdir -p "$AGENT_DIR/logs"

# 3. Start as background process
echo "Starting Telegram bot server..."
nohup node "$SERVER_SCRIPT" >> "$LOG_FILE" 2>&1 &

PID=$!
sleep 1                        # give it a moment to start

# 4. Verify it started
if kill -0 "$PID" 2>/dev/null; then
  echo "Telegram server started (PID: $PID)"
  echo "   Log: $LOG_FILE"
else
  echo "Server failed to start. Check log:"
  tail -20 "$LOG_FILE"
  exit 1
fi
```

`nohup` makes it survive the terminal closing. `>> "$LOG_FILE" 2>&1` sends both stdout and stderr to the log file. The PID is written by the server itself (`index.js` writes `.telegram-server.pid`), not by the start script.

#### `scripts/telegram-stop.sh` — Stop the Server

```bash
#!/usr/bin/env zsh
set -e

PID_FILE="$AGENT_DIR/.telegram-server.pid"

# 1. No PID file → check for stray processes
if [ ! -f "$PID_FILE" ]; then
  echo "No PID file found"
  PIDS=$(pgrep -f "telegram-server.js" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "   Found stray process(es): $PIDS"
  fi
  exit 0
fi

# 2. Read PID and check
PID=$(cat "$PID_FILE")
if ! kill -0 "$PID" 2>/dev/null; then
  echo "Server not running (PID $PID is gone), cleaning up PID file"
  rm -f "$PID_FILE"
  exit 0
fi

# 3. Send SIGTERM (polite)
echo "Stopping Telegram server (PID: $PID)..."
kill "$PID"

# 4. Wait up to 5 seconds for graceful shutdown
for i in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Server stopped"
    rm -f "$PID_FILE"
    exit 0
  fi
  sleep 0.5
done

# 5. Force kill if still running
echo "Server didn't stop gracefully, force killing..."
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "Server force-stopped"
```

First tries SIGTERM (polite), waits 5 seconds, then SIGKILL (forceful). Removes the PID file in all cases.

#### `scripts/telegram-status.sh` — Health Check

This script does four checks:

1. **Configuration:** Reads `.env`, shows masked token and chat ID
2. **Process:** Checks if PID file exists and process is alive, shows uptime
3. **State:** Shows the last processed update ID
4. **API Connectivity:** Calls `getMe` to verify the bot token is still valid

Example output:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  MyBot Telegram Server Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Configuration:
   Bot token: ...ABCdef12
   Chat ID:   987654321

Process:
   Status: Running (PID: 12345)
   Uptime: 02:34:12

State:
   Last update ID: 42

Recent logs:
[2026-05-16T12:34:56] [Ayoub] /mission fix login bug
[2026-05-16T12:34:56] Mission created: 2026-05-16-7890-fix-the-login-bug.md
...

API connectivity:
   Connected to @MyBotBot (MyBot)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 3.5 Shell Tools: Messaging Utilities

#### `tools/telegram-send.sh` — Fire-and-Forget Messages

```bash
#!/usr/bin/env bash
set -e

# Source .env for token and chat ID
source "$AGENT_DIR/.env"

MESSAGE="$1"                            # first argument or stdin
MAX_LEN=4000
if [ ${#MESSAGE} -gt $MAX_LEN ]; then
  MESSAGE="${MESSAGE:0:$MAX_LEN}..."    # truncate at 4000 chars
fi

# POST to Telegram API
RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${MESSAGE}" \
  -d "parse_mode=HTML" 2>&1)

OK=$(echo "$RESPONSE" | jq -r '.ok' 2>/dev/null)
if [ "$OK" = "true" ]; then
  echo "Sent"
else
  echo "Failed: $RESPONSE"
  exit 1
fi
```

Usage:
```bash
./tools/telegram-send.sh "Deploy complete"
echo "Build failed: 3 tests" | ./tools/telegram-send.sh
```

#### `tools/telegram-poll.sh` — Manual Message Checking

This is a standalone poller (separate from the Node.js server). Useful for debugging or when you want to check messages without starting the server.

```bash
#!/usr/bin/env zsh
set -e

source "$AGENT_DIR/.env"
STATE_FILE="$AGENT_DIR/.telegram-last-update"

# Read last update ID (start from 0 if never polled)
LAST_UPDATE=0
[ -f "$STATE_FILE" ] && LAST_UPDATE=$(cat "$STATE_FILE")

poll_once() {
  local OFFSET=$((LAST_UPDATE + 1))
  local RESPONSE=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${OFFSET}&timeout=5")

  local OK=$(echo "$RESPONSE" | jq -r '.ok')
  if [ "$OK" != "true" ]; then
    echo "API error: $RESPONSE"
    return 1
  fi

  # Parse each update: update_id|chat_id|from|text
  echo "$RESPONSE" | jq -r '.result[] | "\(.update_id)|\(.message.chat.id)|\(.message.from.first_name // "Unknown")|\(.message.text // "[non-text]")"' | while IFS='|' read -r UPDATE_ID CHAT_ID FROM TEXT; do
    if [ -n "$UPDATE_ID" ] && [ "$UPDATE_ID" -gt "$LAST_UPDATE" ] 2>/dev/null; then
      echo "[${FROM}] ${TEXT}"
      LAST_UPDATE=$UPDATE_ID
      echo "$LAST_UPDATE" > "$STATE_FILE"     # persist the new offset
    fi
  done
}

# --watch mode: continuously poll every 3 seconds
case "${1:-}" in
  --watch)
    echo "Watching for Telegram messages (Ctrl+C to stop)..."
    while true; do poll_once; sleep 3; done
    ;;
  *) poll_once ;;
esac
```

This uses the **same** `.telegram-last-update` file as the Node.js server. So if you run `telegram-poll.sh` while the server is running, they'll share the same offset — and messages might be claimed by whichever polls first.

#### `tools/telegram-inbox.sh` — Message Inbox Browser

Reads `logs/messages.jsonl` and provides views:

```bash
# Show unreplied messages (default)
./tools/telegram-inbox.sh

# Show all messages
./tools/telegram-inbox.sh --all

# Show statistics
./tools/telegram-inbox.sh --stats

# Mark a message as replied
./tools/telegram-inbox.sh --mark 42
```

The `--stats` output looks like:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Telegram Inbox Statistics
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Inbox file: /srv/dev/agents/my-bot/logs/messages.jsonl
  Total messages:  42
  Unreplied:       3
  Replied:         39

  ── Latest unreplied ──
  [#45] 2026-05-16T12:34:56.000Z | Ayoub: /mission fix the bug
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

#### `tools/telegram-heartbeat.sh` — Status Updates

A one-line wrapper around `telegram-send.sh`:

```bash
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/telegram-send.sh" "$1"
```

Just a semantic alias — "send a heartbeat" sounds better than "send a message" in mission context.

#### `tools/mission-summary.sh` — Mission History

Parses mission files in `missions/{todo,in-progress,done,failed}/` and extracts metadata from each. Supports `-n N` (last N missions) and `-a` (all missions).

#### `tools/aliases.sh` — Shell Shortcuts

```bash
alias tg-start='{{AGENT_DIR}}/scripts/telegram-start.sh'
alias tg-stop='{{AGENT_DIR}}/scripts/telegram-stop.sh'
alias tg-restart='{{AGENT_DIR}}/scripts/telegram-restart.sh'
alias tg-status='{{AGENT_DIR}}/scripts/telegram-status.sh'
alias tg-log='tail -f {{AGENT_DIR}}/logs/telegram.log'
alias tg-inbox='{{AGENT_DIR}}/tools/telegram-inbox.sh'
alias tg-errors='tail -f {{AGENT_DIR}}/logs/errors.log'
alias tg-update='bash {{AGENT_DIR}}/tools/telegram-heartbeat.sh'
alias mission-summary='{{AGENT_DIR}}/tools/mission-summary.sh'
```

Source this in `~/.zshrc` to get all shortcuts:
```bash
source /srv/dev/agents/my-bot/tools/aliases.sh
```

### 3.6 Directory Layout After Generation

```
/srv/dev/agents/my-bot/
├── .env                        ← bot token, chat ID, API keys
├── .gitignore                  ← ignores .env, logs, node_modules
├── CLAUDE.md                   ← agent identity + operating instructions
├── package.json                ← minimal, @anthropic-ai/sdk
├── node_modules/               ← installed by generate-agent.sh
│
├── memory/
│   ├── MEMORY.md               ← index of all memories
│   ├── agent-identity.md       ← who this agent is
│   └── incident-reports.md     ← incident report procedure
│
├── scripts/
│   ├── telegram-start.sh       ← nohup node telegram-server.js &
│   ├── telegram-stop.sh        ← kill + wait + force kill
│   ├── telegram-restart.sh     ← stop, sleep 1, start
│   └── telegram-status.sh      ← PID + uptime + last update + API check
│
├── tools/
│   ├── telegram-server.js      ← the thin wrapper (requires kit)
│   ├── telegram-send.sh        ← curl POST sendMessage
│   ├── telegram-heartbeat.sh   ← calls telegram-send.sh
│   ├── telegram-poll.sh        ← curl GET getUpdates (standalone)
│   ├── telegram-inbox.sh       ← parse messages.jsonl with jq
│   ├── mission-summary.sh      ← parse mission files
│   └── aliases.sh              ← tg-start, tg-stop, etc.
│
├── logs/
│   ├── telegram.log            ← server stdout/stderr
│   ├── errors.log              ← structured error log
│   └── messages.jsonl          ← incoming message inbox
│
├── missions/
│   ├── todo/                   ← created but not yet started
│   ├── in-progress/            ← actively running
│   ├── done/                   ← completed successfully
│   ├── failed/                 ← failed or cancelled
│   └── results/                ← Claude stdout output files
│
├── knowledge/                  ← empty, for project knowledge
└── sandbox/                    ← safe workspace for experiments
```

---

## Part 4: Full Command Flows

Now let's trace exactly what happens when each command arrives, from Telegram API all the way to the response.

### 4.1 `/start` — Welcome Message

```
User sends: /start
────────────────────────────────────────────────────────

1. Telegram stores the message internally

2. Agent's next poll cycle:
   GET /getUpdates?offset=43&timeout=30
   ← { ok: true, result: [{ update_id: 43, message: { text: "/start", chat: { id: 123 }, from: { first_name: "Ayoub" } } }] }

3. poll() — index.js:231-254
   ├── offset = 42 + 1 = 43 (correct, gets this update)
   ├── resp.ok = true ✓
   ├── consErrors reset to 0
   ├── for each update in [43]:
   │   ├── saveLastUpdate(43)          → writes "43" to .telegram-last-update
   │   └── processUpdate(update_43)
   │
   └── processUpdate() — index.js:154-228
        ├── text = "/start" ✓
        ├── chatId = 123 ✓
        ├── storeMsg({ update_id: 43, from: "Ayoub", text: "/start", ... })
        │   → appends JSON line to logs/messages.jsonl
        ├── No gen session active ✓
        ├── cleanText = "/start"
        ├── Matches /^\/start$/i ✓
        └── await handleStart(chatId=123, updateId=43)

4. handleStart() — index.js:75-85
   ├── tg.sendMessage(123, "<b>MyBot</b> — AI dev agent\n\n<b>Commands:</b>...")
   │   → POST /sendMessage { chat_id: 123, text: "...", parse_mode: "HTML" }
   │
   └── store.markReplied(43)
        → rewrites messages.jsonl with "replied": true for update_id 43

5. User sees in Telegram:
   ┌──────────────────────────────────────┐
   │ MyBot — AI dev agent                 │
   │                                      │
   │ Commands:                            │
   │ /mission <task> — Full Claude CLI    │
   │ /externalllm <query> — DeepSeek API  │
   │ Any text — Quick AI answer           │
   └──────────────────────────────────────┘
```

### 4.2 `/mission` — The Full Mission Flow

This is the most complex path. Let's trace it end to end.

```
User sends: /mission fix the login bug on the signup page
──────────────────────────────────────────────────────────────────────

── PHASE 1: RECEIVE ──────────────────────────────────────────────────

1. Telegram stores the message

2. Agent's poll returns it:
   GET /getUpdates?offset=44&timeout=30
   ← { ok: true, result: [{ update_id: 44, message: { text: "/mission fix the login bug..." } }] }

3. processUpdate() routes to handleMission()

── PHASE 2: CREATE MISSION FILE ─────────────────────────────────────

4. handleMission() — index.js:87-108:

   a. this.missions.create(taskText)
      → Writes: missions/todo/2026-05-16-7890-fix-the-login-bug-on-the-signup-.md

      Contents:
      ┌─────────────────────────────────────────────────────────────┐
      │ # Mission: fix the login bug on the signup page             │
      │                                                             │
      │ | Field | Detail |                                          │
      │ |-------|--------|                                          │
      │ | **Created** | 2026-05-16T12:34:56.000Z |                  │
      │ | **Status** | todo |                                       │
      │ | **Source** | Telegram |                                   │
      │ | **PID** | - |                                             │
      │                                                             │
      │ ## Original Request                                         │
      │ fix the login bug on the signup page                        │
      │                                                             │
      │ ## Progress Log                                             │
      │ | Timestamp | Event | Detail |                              │
      │ |-----------|-------|--------|                              │
      └─────────────────────────────────────────────────────────────┘

   b. updateMeta(file, { Status: "in-progress" })
      → Changes "todo" to "in-progress" in the file

   c. missions.move(file, missions/in-progress/)
      → mv missions/todo/...md missions/in-progress/...md

   d. appendLog(file, "started", "Starting Claude worker")
      → Inserts row: | 2026-05-16T12:34:56.000Z | started | Starting Claude worker |

   e. tg.sendMessage(chatId, "<b>Mission starting</b>\nfix the login bug...")
      → User sees: "Mission starting — fix the login bug... — Claude CLI (no limits)."

── PHASE 3: SPAWN CLAUDE ─────────────────────────────────────────────

   f. claude.spawn(taskText, missionFile, chatId, AGENT_DIR)
      → claude-worker.js:130-178

      i.   Creates empty result file:
           missions/results/2026-05-16-7890-fix-the-login-bug-on-the-signup-_result.md

      ii.  Spawns child process:
           claude -p "fix the login bug on the signup page" \
                  --output-format text \
                  --dangerously-skip-permissions \
                  --no-session-persistence

      iii. Sets up stdout capture:
           child.stdout.on("data", (d) => { stdout += d.toString(); })

      iv.  Sets up close handler:
           child.on("close", (code, signal) => {
             fs.writeFileSync(resultFile, stdout || "(no output)");
           })

      v.   Returns PID: 12345

   g. updateMeta(file, { PID: "12345" })
      → Updates the mission file's metadata table

   h. appendLog(file, "claude_spawned", "PID 12345")
      → Inserts row: | ... | claude_spawned | PID 12345 |

── PHASE 4: HEARTBEAT MONITOR ────────────────────────────────────────

   i. claude.startMonitor(missionFile, chatId, 12345)
      → claude-worker.js:30-128

      i.   Sends first progress message:
           tg.sendMessage(chatId, "Mission in progress\nElapsed: 0m 0s | Heartbeats: 0")
           → Captures message_id: 567

      ii.  Adds monitor to activeMonitors[]

      iii. Schedules first tick in 60 seconds

      --- 60 seconds later ---

      iv.  First tick:
           process.kill(12345, 0) → alive ✓
           tg.editMessage(chatId, 567, "Mission in progress\nElapsed: 1m 0s | Heartbeats: 1")
           Schedules next tick in 60 seconds

      --- Another 60 seconds ---

      v.   Second tick:
           process.kill(12345, 0) → alive ✓
           tg.editMessage(chatId, 567, "Mission in progress\nElapsed: 2m 0s | Heartbeats: 2")
           Schedules next tick...

      --- Claude finishes after 12 minutes ---

      vi.  Claude process exits naturally
           → close handler fires
           → writes stdout to result file

      vii. Next tick (at 12m0s):
           elapsed = 720 seconds
           heartbeatCount = 12
           process.kill(12345, 0) → NOT alive ✗

           → Reads result file
           → resultText = "I found the bug in auth/login.ts:\n..."
           → tg.sendMessage(chatId, "<b>Mission complete</b> (12m 0s)\n\nI found the bug...")
           → appendLog(file, "completed", "Result 850 chars, 720s")
           → updateMeta(file, { Status: "completed" })
           → missions.move(file, missions/done/)
           → Removes monitor from activeMonitors[]

── PHASE 5: USER SEES RESULT ─────────────────────────────────────────

5. User sees in Telegram:
   ┌──────────────────────────────────────┐
   │ Mission complete (12m 0s)            │
   │                                      │
   │ I found the bug in auth/login.ts:    │
   │ The validateToken() function was     │
   │ not handling null tokens...          │
   │                                      │
   │ Fixed by adding a null check at      │
   │ line 142. Tests pass.               │
   └──────────────────────────────────────┘
```

### 4.3 `/externalllm <query>` — DeepSeek API Call

```
User sends: /externalllm explain how JWT works
────────────────────────────────────────────────────────

1. processUpdate() matches /^\/externalllm\b/i

2. Extracts query: "explain how JWT works"

3. handleExternalLlm():
   a. tg.sendMessage(chatId, "Calling DeepSeek API...")
   b. ai.callDeepSeekSDK("explain how JWT works", {
        maxTokens: 4096, timeout: 60000,
        system: "You are MyBot. Provide detailed, thorough responses."
      })
   c. SDK makes HTTPS request to DeepSeek API
   d. Extracts text from response
   e. tg.sendMessage(chatId, "JWT (JSON Web Token) is...")
```

### 4.4 Any Other Text — Quick AI Answer

```
User sends: how do I deploy this?
────────────────────────────────────────────────────────

1. No command match → handleDefault()

2. handleDefault():
   a. tg.sendMessage(chatId, "Processing...")
   b. Try: ai.callDeepSeek("how do I deploy this?", {
        maxTokens: 1024, timeout: 30000
      })
   c. If success → tg.sendMessage(chatId, response)
   d. If failure → "API unavailable, switching to Claude CLI..."
                   → ai.spawnClaudeSync(prompt, "0.50", 120000, cwd)
                   → tg.sendMessage(chatId, response)
```

---

## Part 5: Error Handling & Resilience

### 5.1 Consecutive Poll Errors

`index.js:236-254`:

```js
if (!resp.ok) {
  this.consErrors++;
  if (this.consErrors >= 10) {
    this.logError("FATAL", "Too many tg errors");
    process.exit(1);               // give up after 10 consecutive failures
  }
  return;
}
this.consErrors = 0;               // reset on any success
```

10 consecutive failures = server exits. A single success resets the counter. At one poll every ~30 seconds, that's 5 minutes of continuous failure before giving up.

### 5.2 Message Send/Edit Failures

Both `sendMessage` and `editMessage` are wrapped in try/catch in the heartbeat monitor. If editing the progress message fails (e.g., message was deleted), a new message is sent:

```js
try {
  await this.tg.editMessage(chatId, progressMsgId, text);
} catch {
  // Edit failed → send a new message
  const resp = await this.tg.sendMessage(chatId, text);
  progressMsgId = resp.body?.result?.message_id;  // track the new message
}
```

### 5.3 Claude Spawn Failures

If `spawn()` itself fails (can't find the `claude` binary, permission denied), the error handler writes to the result file:

```js
child.on("error", (err) => {
  fs.writeFileSync(resultFile, `SPAWN ERROR: ${err.message}`);
});
```

When the heartbeat monitor detects the process is dead and reads the result, it'll find "SPAWN ERROR: ..." and send that to the user. The user sees: "Mission complete — SPAWN ERROR: claude: command not found."

### 5.4 AI Backend Failures (Cascading Fallback)

```
User sends text
  │
  ├─ Try: DeepSeek direct API (1024 tokens, 30s timeout)
  │   └─ Success → send response
  │   └─ Failure ↓
  │
  ├─ Try: Claude CLI sync (0.50 budget, 120s timeout)
  │   └─ Success → send response
  │   └─ Failure ↓
  │
  └─ Send: "All AI backends unavailable."
```

### 5.5 Recovery After Server Crash

1. Server crashes (OOM, killed, power failure, etc.)
2. Claude child processes **keep running** — they're independent OS processes
3. User restarts the server: `tg-start`
4. `start()` calls `claude.recoverMonitors(chatId)`
5. Reads all `missions/in-progress/*.md` files
6. For each: extracts PID, checks `process.kill(pid, 0)`
7. If alive → resumes heartbeat monitoring
8. If dead → moves mission to `failed/`

**The user sees:** After restart, the heartbeat message resumes editing. Or, if Claude finished during the outage, they get the "Mission complete" message immediately after restart.

### 5.6 Uncaught Exceptions

```js
process.on("uncaughtException", (err) => {
  server.logError("FATAL", "Uncaught", err.message + "\n" + (err.stack || ""));
  process.exit(1);     // crash deliberately — let the shell scripts restart
});

process.on("unhandledRejection", (r) => {
  server.logError("ERROR", "Unhandled rejection", r?.message || String(r));
  // does NOT exit — continues running
});
```

Fatal on uncaught exception (crashed, let restart handle it). Log-and-continue on unhandled promise rejection.

---

## Part 6: The Agent Generator

### 6.1 What Gets Templated

17 files are generated from templates. Each contains `{{PLACEHOLDER}}` markers that get replaced with actual values:

| Template | Output | Purpose |
|---|---|---|
| `CLAUDE.md.tmpl` | `CLAUDE.md` | Agent identity + instructions |
| `.env.tmpl` | `.env` | Tokens, URLs, configuration |
| `package.json.tmpl` | `package.json` | npm dependencies |
| `memory/MEMORY.md.tmpl` | `memory/MEMORY.md` | Memory index |
| `memory/agent-identity.md.tmpl` | `memory/agent-identity.md` | Identity memory |
| `memory/incident-reports.md.tmpl` | `memory/incident-reports.md` | Incident procedure |
| `tools/aliases.sh.tmpl` | `tools/aliases.sh` | Shell shortcuts |
| `tools/telegram-server.js.tmpl` | `tools/telegram-server.js` | Bot server wrapper |
| `tools/telegram-send.sh.tmpl` | `tools/telegram-send.sh` | Send messages |
| `tools/telegram-heartbeat.sh.tmpl` | `tools/telegram-heartbeat.sh` | Status updates |
| `tools/telegram-inbox.sh.tmpl` | `tools/telegram-inbox.sh` | Message inbox |
| `tools/telegram-poll.sh.tmpl` | `tools/telegram-poll.sh` | Manual polling |
| `tools/mission-summary.sh.tmpl` | `tools/mission-summary.sh` | Mission history |
| `scripts/telegram-start.sh.tmpl` | `scripts/telegram-start.sh` | Start server |
| `scripts/telegram-stop.sh.tmpl` | `scripts/telegram-stop.sh` | Stop server |
| `scripts/telegram-restart.sh.tmpl` | `scripts/telegram-restart.sh` | Restart server |
| `scripts/telegram-status.sh.tmpl` | `scripts/telegram-status.sh` | Health check |

### 6.2 Two Modes

**From a config file:**
```bash
./tools/generate-agent.sh --config my-agent.env
```

The config file is simple KEY=VALUE:
```bash
AGENT_NAME=my-bot
AGENT_DISPLAY_NAME="My Bot"
AGENT_DIR=/srv/dev/agents/my-bot
PROJECT_DIR=/srv/dev/my-app
PROJECT_NAME=MyApp
PROJECT_DESCRIPTION="My awesome app"
TELEGRAM_BOT_TOKEN=123456:ABCdef
TELEGRAM_CHAT_ID=987654321
ANTHROPIC_AUTH_TOKEN=sk-xxx
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
GITHUB_REPO=user/repo
PROD_URL=https://myapp.com
AGENT_USERNAME=@MyAppBot
AGENT_ROLE="AI dev agent for MyApp"
```

**Interactive mode:**
```bash
./tools/generate-agent.sh --interactive
```

Prompts for each value one by one. Builds the config and runs the generator.

### 6.3 Post-Generation

After writing all files, `generate-agent.sh`:

1. **Creates a `.gitignore`** — ignores .env, logs, PID files, node_modules
2. **Touches empty log files** — so the server doesn't error on first write
3. **Runs `npm install`** — installs `@anthropic-ai/sdk`
4. **Prints a summary** — agent name, directory, next steps

---

## Part 7: How Everything Fits Together on the Machine

```
/srv/dev/
├── agents/
│   ├── telegram-agent-kit/          ← THE SHARED LIBRARY
│   │   ├── index.js                 ← AgentServer class
│   │   ├── config.js                ← Config loader
│   │   ├── telegram-client.js       ← Bot API HTTP client
│   │   ├── message-store.js         ← Inbox persistence
│   │   ├── mission-manager.js       ← Mission CRUD
│   │   ├── claude-worker.js         ← Claude spawn + monitor
│   │   ├── ai-backends.js           ← API clients
│   │   └── package.json
│   │
│   ├── agent-generator/             ← THE GENERATOR (this agent)
│   │   ├── templates/               ← Agent templates
│   │   ├── tools/generate-agent.sh  ← Generation script
│   │   └── docs/                    ← Documentation
│   │
│   ├── mouss-ai/                    ← Generated agent #1
│   │   ├── .env                     ← Bot token for @MoussawerAgentBot
│   │   ├── tools/telegram-server.js ← require("telegram-agent-kit")
│   │   └── ...
│   │
│   ├── my-app-bot/                  ← Generated agent #2
│   │   ├── .env                     ← Bot token for @MyAppBot
│   │   ├── tools/telegram-server.js ← require("telegram-agent-kit")
│   │   └── ...
│   │
│   └── ...                          ← More agents
│
├── dev/
│   ├── moussawer/                   ← Agent #1's project
│   ├── my-app/                      ← Agent #2's project
│   └── ...
```

Each agent is fully isolated:
- **Own bot token** — its own Telegram identity
- **Own chat ID** — messages go to its own user
- **Own process** — crashes don't affect other agents
- **Own mission files** — no shared state

But they all **share** the same library code from `telegram-agent-kit/`. When the kit is updated, all agents get the improvements on next restart.

---

## Part 8: Summary — The Complete Picture

Here is the entire system in one timeline:

```
┌─ STARTUP ─────────────────────────────────────────────────────────────┐
│                                                                        │
│  cd /srv/dev/agents/my-bot                                             │
│  ./scripts/telegram-start.sh                                           │
│    ├─ nohup node tools/telegram-server.js >> logs/telegram.log 2>&1 & │
│    │                                                                    │
│    └─ Node.js process starts:                                          │
│         ├─ Reads .env → { TG_TOKEN, CHAT_ID, DS_API_KEY, ... }        │
│         ├─ Creates all directories                                     │
│         ├─ Writes PID to .telegram-server.pid                          │
│         ├─ Calls getMe → verifies bot token                           │
│         ├─ Recovers any in-progress missions                           │
│         ├─ Sends "MyBot online." to Telegram                           │
│         └─ Enters infinite polling loop                                │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ POLLING LOOP ───────────────────────────────────────────────────────┐
│                                                                        │
│  while (true) {                                                        │
│    offset = read(".telegram-last-update") + 1                          │
│    response = GET /getUpdates?offset=${offset}&timeout=30              │
│                                                                        │
│    if (response has updates) {                                         │
│      for (each update) {                                               │
│        save(update.update_id)           ← persist offset              │
│        processUpdate(update)            ← route the message           │
│      }                                                                 │
│    }                                                                   │
│  }                                                                     │
│                                                                        │
│  Wait: up to 30 seconds per poll                                       │
│  Average latency: ~15 seconds (half the timeout)                       │
│  Gap between polls: < 100 ms                                           │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ MESSAGE ROUTING ────────────────────────────────────────────────────┐
│                                                                        │
│  Incoming message text:                                                │
│                                                                        │
│  "/start"              → Welcome + command list                        │
│  "/mission <task>"     → Create file → spawn claude → monitor         │
│  "/externalllm <q>"    → DeepSeek SDK → send response                 │
│  any other text        → DeepSeek API → send response                 │
│                          (fallback: Claude CLI sync)                   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (for /mission)
┌─ MISSION LIFECYCLE ──────────────────────────────────────────────────┐
│                                                                        │
│  missions/todo/         ← Mission created here                        │
│       │                                                                │
│       ▼  (move)                                                       │
│  missions/in-progress/  ← Mission runs here                           │
│       │                  Claude CLI spawned as child process          │
│       │                  Heartbeat edits progress message every 60s   │
│       │                                                                │
│       ├─ Success → missions/done/    ← Result sent to user           │
│       └─ Failure → missions/failed/  ← Error sent to user            │
│                                                                        │
│  missions/results/      ← Raw Claude stdout captured here             │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ SHELL TOOLS (DECOUPLED FROM SERVER) ────────────────────────────────┐
│                                                                        │
│  telegram-send.sh "msg"     → curl POST sendMessage                   │
│  telegram-poll.sh --watch   → standalone poll loop                    │
│  telegram-inbox.sh --stats  → parse messages.jsonl                    │
│  telegram-status.sh         → PID + uptime + API check                │
│  mission-summary.sh -n 3    → last 3 mission summaries                │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Appendix: Key Design Decisions (The "Why")

**Why polling instead of webhooks?**
These agents run behind firewalls without public HTTPS endpoints. Polling (outgoing HTTPS) works from anywhere. Webhooks require public URLs with TLS certificates.

**Why files instead of a database?**
For a single-user bot handling ~50 messages/day, files are simpler, debuggable (`cat`, `jq`, grep), and need zero administration. No database to manage, backup, or migrate.

**Why a shared library instead of per-agent code?**
17 files per agent × 10 agents = 170 files to maintain. The shared library means one fix updates all agents. Generated agent files are thin wrappers — 20 lines of JS, configuration-only shell scripts.

**Why Claude CLI instead of the API for missions?**
Claude CLI has built-in tools (Read, Edit, Write, Bash) that give it full access to the filesystem. The API requires implementing tool use yourself. The CLI is the "agent mode" — autonomous, no permission prompts.

**Why `--dangerously-skip-permissions`?**
Without it, Claude asks approval for every file edit and command. For a `/mission` sent via Telegram, there's no one to approve. The agent must operate autonomously.

**Why 60-second heartbeat interval?**
Balance between visibility (user wants updates) and API rate limits (Telegram has ~30 messages/second but recommends reasonable rates). 60 seconds is frequent enough to feel alive but infrequent enough to avoid rate limits.

**Why no message queue or retry?**
Telegram's API has 99.95%+ uptime. For a single-user bot, message delivery failures are extremely rare. The complexity of a persistent outbound queue (SQLite, retry logic, dead letter handling) exceeds the benefit at this scale.
