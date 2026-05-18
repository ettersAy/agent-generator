// queue.js — Mission queue snapshot and operations (shared by server + dashboard)
const fs = require("fs");
const path = require("path");

const AGENT_DIR = "/srv/dev/agents/agent-generator";
const MISSIONS_DIR = path.join(AGENT_DIR, "missions");

function getQueueSnapshot() {
  const dirs = {
    todo: path.join(MISSIONS_DIR, "todo"),
    inProgress: path.join(MISSIONS_DIR, "in-progress"),
    done: path.join(MISSIONS_DIR, "done"),
    failed: path.join(MISSIONS_DIR, "failed"),
  };

  const result = { todo: [], inProgress: [], done: [], failed: [] };

  for (const [key, dir] of Object.entries(dirs)) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of files) {
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        const content = fs.readFileSync(fp, "utf8");
        const titleMatch = content.match(/^# Mission: (.+)$/m);
        const statusMatch = content.match(/\| \*\*Status\*\* \| (.+) \|/);
        const pidMatch = content.match(/\| \*\*PID\*\* \| (.+) \|/);

        // Check if a runner is currently active
        let runnerAlive = false;
        let runnerPid = null;
        if (key === "inProgress") {
          const pidFile = path.join(MISSIONS_DIR, "in-progress", f.replace(".md", ".pid"));
          if (fs.existsSync(pidFile)) {
            try {
              runnerPid = parseInt(fs.readFileSync(pidFile, "utf8"));
              process.kill(runnerPid, 0);
              runnerAlive = true;
            } catch {}
          }
        }

        // Check result file
        const resultFile = path.join(MISSIONS_DIR, "results", f.replace(".md", "_result.md"));
        let resultSize = 0;
        if (fs.existsSync(resultFile)) {
          try {
            resultSize = fs.statSync(resultFile).size;
          } catch {}
        }

        result[key].push({
          filename: f,
          id: f.replace(".md", ""),
          title: titleMatch ? titleMatch[1] : f,
          status: statusMatch ? statusMatch[1] : key,
          mtime: stat.mtime,
          pid: pidMatch ? pidMatch[1] : (runnerPid || "-"),
          runnerAlive,
          resultSize,
        });
      } catch {}
    }
  }

  return result;
}

function getDispatcherStatus() {
  const pidFile = path.join(AGENT_DIR, ".mission-dispatcher.pid");
  let running = false;
  let pid = null;
  if (fs.existsSync(pidFile)) {
    try {
      pid = parseInt(fs.readFileSync(pidFile, "utf8"));
      process.kill(pid, 0);
      running = true;
    } catch {}
  }
  return { running, pid };
}

function getLogTail(logFile, lines = 30) {
  if (!fs.existsSync(logFile)) return "";
  try {
    const content = fs.readFileSync(logFile, "utf8");
    return content.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

module.exports = { getQueueSnapshot, getDispatcherStatus, getLogTail, MISSIONS_DIR };
