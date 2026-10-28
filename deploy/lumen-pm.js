#!/usr/bin/env node
/**
 * lumen-pm.js — production process manager for lumen-chain
 *
 * Features:
 *   1. Auto-restart on crash (with backoff)
 *   2. Log rotation (size-based)
 *   3. Graceful shutdown (SIGTERM/SIGINT -> workers -> wait -> SIGKILL)
 *   4. Health checks (HTTP + worker liveness)
 *
 * Usage:
 *   node deploy/lumen-pm.js start|stop|restart|status
 *
 * Env:
 *   LUMEN_CMD        — command to run (default: npx tsx cli/lumen.ts node)
 *   LUMEN_WORKERS    — number of workers (default: 1)
 *   LUMEN_BASE_PORT  — base port for workers (default: 8789)
 *   LUMEN_RPC_PORT   — RPC port for serve mode (default: 8899)
 *   LUMEN_MODE       — node|serve (default: node)
 *   LUMEN_PEERS      — comma-separated peers
 *   LUMEN_LOG_DIR    — log directory (default: ./deploy/logs)
 *   LUMEN_MAX_LOG_MB — max log size in MB (default: 10)
 *   LUMEN_LOG_BACKUPS— number of log backups (default: 5)
 *   LUMEN_HEALTH_PORT— health check HTTP port (default: 9400)
 *   LUMEN_HEALTH_INTERVAL — health check interval ms (default: 15000)
 *   LUMEN_PID_FILE   — pid file path (default: ./deploy/run/lumen-pm.pid)
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync, createWriteStream, mkdirSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import http from "node:http";
import net from "node:net";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name, fallback) {
  return process.env[name] ?? fallback;
}

const CONFIG = {
  cmd: envStr("LUMEN_CMD", "node node_modules/.bin/tsx cli/lumen.ts node"),
  workers: envInt("LUMEN_WORKERS", 1),
  basePort: envInt("LUMEN_BASE_PORT", 8789),
  rpcPort: envInt("LUMEN_RPC_PORT", 8899),
  mode: envStr("LUMEN_MODE", "node"),
  peers: envStr("LUMEN_PEERS", ""),
  logDir: envStr("LUMEN_LOG_DIR", join(process.cwd(), "deploy", "logs")),
  maxLogMb: envInt("LUMEN_MAX_LOG_MB", 10),
  logBackups: envInt("LUMEN_LOG_BACKUPS", 5),
  healthPort: envInt("LUMEN_HEALTH_PORT", 9400),
  healthInterval: envInt("LUMEN_HEALTH_INTERVAL", 15000),
  pidFile: envStr("LUMEN_PID_FILE", join(process.cwd(), "deploy", "run", "lumen-pm.pid")),
};

if (!existsSync(CONFIG.logDir)) mkdirSync(CONFIG.logDir, { recursive: true });
if (!existsSync(dirname(CONFIG.pidFile))) mkdirSync(dirname(CONFIG.pidFile), { recursive: true });

const workers = [];
let shuttingDown = false;

function workerArgs(port, rpcPort) {
  const args = [CONFIG.mode];
  if (CONFIG.mode === "node") {
    args.push(`--port=${port}`);
  } else {
    args.push(`--port=${rpcPort}`);
  }
  if (CONFIG.peers) args.push(`--peers=${CONFIG.peers}`);
  return args;
}

function spawnWorker(id) {
  const port = CONFIG.basePort + id;
  const rpcPort = CONFIG.rpcPort + id;
  const logPath = join(CONFIG.logDir, `lumen-${id}.log`);
  const errPath = join(CONFIG.logDir, `lumen-${id}.err.log`);

  const wargs = workerArgs(port, rpcPort);
  let cmd, args;
  if (CONFIG.cmd.startsWith("npm run ")) {
    const script = CONFIG.cmd.slice("npm run ".length);
    cmd = "npm";
    args = ["run", script, "--", ...wargs];
  } else {
    const parts = CONFIG.cmd.split(/\s+/);
    cmd = parts[0];
    args = [...parts.slice(1), ...wargs];
  }

  const proc = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LUMEN_HOME: join(process.cwd(), ".lumen") },
    detached: true,
  });

  const outStream = createWriteStream(logPath, { flags: "a" });
  const errStream = createWriteStream(errPath, { flags: "a" });

  proc.stdout && proc.stdout.pipe(outStream);
  proc.stderr && proc.stderr.pipe(errStream);

  const w = {
    id,
    proc,
    port,
    rpcPort,
    logPath,
    errPath,
    restarts: 0,
    lastRestart: 0,
    alive: true,
  };

  proc.on("exit", (code, sig) => {
    w.alive = false;
    if (!shuttingDown) {
      const now = Date.now();
      if (now - w.lastRestart < 10_000) {
        setTimeout(() => {
          if (!shuttingDown && !w.alive) respawn(id);
        }, 10_000);
        return;
      }
      w.restarts++;
      w.lastRestart = now;
      setTimeout(() => {
        if (!shuttingDown && !w.alive) respawn(id);
      }, 1000);
    }
  });

  return w;
}

function respawn(id) {
  const idx = workers.findIndex((w) => w.id === id);
  if (idx === -1) return;
  const old = workers[idx];
  try { process.kill(-old.proc.pid, "SIGTERM"); } catch {}
  setTimeout(() => {
    try { process.kill(-old.proc.pid, "SIGKILL"); } catch {}
  }, 3000);
  const newW = spawnWorker(id);
  newW.restarts = old.restarts + 1;
  newW.lastRestart = Date.now();
  workers[idx] = newW;
}

function rotateLogs() {
  const maxBytes = CONFIG.maxLogMb * 1024 * 1024;
  for (const w of workers) {
    for (const file of [w.logPath, w.errPath]) {
      try {
        const st = statSync(file);
        if (st.size > maxBytes) {
          for (let i = CONFIG.logBackups; i > 1; i--) {
            const src = `${file}.${i - 1}`;
            const dst = `${file}.${i}`;
            if (existsSync(src)) {
              try { renameSync(src, dst); } catch {}
            }
          }
          try { renameSync(file, `${file}.1`); } catch {}
          writeFileSync(file, "");
        }
      } catch {}
    }
  }
}

function checkPort(port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function healthCheck() {
  const workerStatus = [];
  for (const w of workers) {
    workerStatus.push({
      id: w.id,
      alive: w.alive,
      port: w.port,
      rpcPort: w.rpcPort,
      portOpen: await checkPort(w.port),
      restarts: w.restarts,
    });
  }
  const healthy = workerStatus.filter((w) => w.alive && w.portOpen).length;
  return {
    status: healthy > 0 ? (healthy === workers.length ? "ok" : "degraded") : "down",
    workers: workerStatus,
    uptime: process.uptime(),
    timestamp: Date.now(),
  };
}

function startHealthServer() {
  const server = http.createServer(async (_req, res) => {
    try {
      const health = await healthCheck();
      res.writeHead(health.status === "ok" ? 200 : 503);
      res.end(JSON.stringify(health, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: "error", error: String(e) }));
    }
  });
  server.listen(CONFIG.healthPort, "127.0.0.1", () => {
    console.log(`[pm] health endpoint http://127.0.0.1:${CONFIG.healthPort}/health`);
  });
  server.on("error", (e) => {
    console.error(`[pm] health server error: ${e.message}`);
  });
  return server;
}

async function startAll() {
  console.log(`[pm] starting ${CONFIG.workers} worker(s) in ${CONFIG.mode} mode`);
  for (let i = 0; i < CONFIG.workers; i++) {
    workers.push(spawnWorker(i));
    await sleep(500);
  }
  startHealthServer();
  setInterval(rotateLogs, 60_000);
}

async function stopAll() {
  shuttingDown = true;
  console.log("[pm] stopping workers...");
  const procs = workers.map((w) => w.proc);
  for (const p of procs) {
    try { process.kill(-p.pid, "SIGTERM"); } catch {}
  }
  await sleep(5000);
  for (const p of procs) {
    try { process.kill(-p.pid, "SIGKILL"); } catch {}
  }
  workers.length = 0;
}

function writePid() {
  writeFileSync(CONFIG.pidFile, String(process.pid));
}

function removePid() {
  try { unlinkSync(CONFIG.pidFile); } catch {}
}

function isRunning() {
  if (!existsSync(CONFIG.pidFile)) return false;
  const pid = Number(readFileSync(CONFIG.pidFile, "utf8").trim());
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const cmd = process.argv[2] || "start";

  if (cmd === "start") {
    if (isRunning()) {
      console.log("[pm] already running");
      process.exit(0);
    }
    writePid();
    await startAll();
    console.log(`[pm] started (pid ${process.pid})`);
  } else if (cmd === "stop") {
    if (!isRunning()) {
      console.log("[pm] not running");
      process.exit(0);
    }
    await stopAll();
    removePid();
    console.log("[pm] stopped");
    process.exit(0);
  } else if (cmd === "restart") {
    const wasRunning = isRunning();
    if (wasRunning) {
      await stopAll();
      removePid();
    }
    writePid();
    await startAll();
    console.log("[pm] restarted");
  } else if (cmd === "status") {
    const health = await healthCheck();
    console.log(JSON.stringify(health, null, 2));
    process.exit(health.status === "down" ? 1 : 0);
  } else {
    console.log("Usage: node deploy/lumen-pm.js <start|stop|restart|status>");
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  console.log("\n[pm] SIGINT received");
  await stopAll();
  removePid();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[pm] SIGTERM received");
  await stopAll();
  removePid();
  process.exit(0);
});

main().catch((e) => {
  console.error("[pm] fatal:", e);
  process.exit(1);
});
