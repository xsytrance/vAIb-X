// server/relay.mjs — vAIb WebSocket broadcast relay
// Dumb pipe: forwards JSON strings between connected browser nodes. No parsing, no state.

import { WebSocketServer } from "ws";
import { createServer } from "http";
import { runDiscovery, formatForBrowser } from "./discovery.mjs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PORT = process.env.RELAY_PORT || 6666;
const clients = new Map(); // clientId → WebSocket
let nextId = 1;
let msgCount = 0;
const started = Date.now();

// ── startup identity ────────────────────────────────────────
console.log(`[vAIb] Backend repo: ${REPO_ROOT}`);
console.log(`[vAIb] Discovery module: ${resolve(__dirname, "discovery.mjs")}`);
console.log(`[vAIb] WebSocket port: ${PORT}`);

// ── discovery cache ─────────────────────────────────────────
let lastDiscovery = null;
const DISCOVERY_INTERVAL = 60000; // re-scan every 60s

async function refreshDiscovery() {
  try {
    const result = await runDiscovery();
    lastDiscovery = formatForBrowser(result);

    // Push to all connected clients
    const payload = JSON.stringify({ type: 'DISCOVERY_RESULT', ...lastDiscovery });
    const agentCount = lastDiscovery.agents?.length || 0;
    // Discovery result broadcast to ${clients.size} clients
    for (const [id, socket] of clients) {
      if (socket.readyState === 1) {
        socket.send(payload);
      }
    }
  } catch (err) {
    log("DISCOVERY_ERR", err.message);
  }
}

// Initial discovery on startup
refreshDiscovery();
// Periodic refresh
setInterval(refreshDiscovery, DISCOVERY_INTERVAL);

// ── logging helper ──────────────────────────────────────────
const log = (event, detail = "") => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[RELAY] ${ts} ${event} ${detail}`.trim());
};

// ── HTTP health endpoint ────────────────────────────────────
const httpServer = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health" && req.method === "GET") {
    const uptime = Math.round((Date.now() - started) / 1000);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", connections: clients.size, uptime }));
    return;
  }
  res.writeHead(404).end();
});

// ── WebSocket server (shared HTTP port, path /signal) ───────
const wss = new WebSocketServer({ server: httpServer, path: "/signal" });

wss.on("connection", (ws, req) => {
  const clientId = nextId++;
  clients.set(clientId, ws);
  log("CONNECT", `id=${clientId} total=${clients.size}`);

  ws.on("message", (raw) => {
    const s = raw.toString();
    // quick peek at type for logging (non-fatal)
    let type = "?";
    try { type = JSON.parse(s).type || "?"; } catch { /* raw text */ }
    msgCount++;
    log("MESSAGE", `id=${clientId} type=${type} #${msgCount}`);

    // broadcast to all OTHER clients
    for (const [id, socket] of clients) {
      if (id !== clientId && socket.readyState === 1 /* OPEN */) {
        socket.send(s);
      }
    }
  });

  ws.on("close", () => {
    clients.delete(clientId);
    log("DISCONNECT", `id=${clientId} total=${clients.size}`);
  });

  ws.on("error", (err) => log("ERROR", `id=${clientId} ${err.message}`));
});

// ── start ───────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  log("START", `port=${PORT} ws=/signal health=/health`);
});

// graceful shutdown
process.on("SIGTERM", () => {
  log("STOP", "SIGTERM received");
  wss.close(() => httpServer.close(() => process.exit(0)));
});
