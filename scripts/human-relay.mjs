#!/usr/bin/env node
// human-relay.mjs — join the agent-bus as a named human peer.
// Provides a readline REPL so a human can send and receive bus messages
// directly, without running an LLM agent.
//
// Usage (standalone):
//   node scripts/human-relay.mjs --name human --bus-root /tmp/pi-mesh-auth
//   npm run mesh-human -- --name human --bus-root /tmp/pi-mesh-auth
//
// Usage (via mesh topology with type: relay):
//   The launch-mesh.mjs launcher spawns this automatically.
//
// Input syntax:
//   @<peer> <body>   — send to a specific peer
//   <body>           — broadcast to all live peers (probes each socket)
//   /peers           — list live peers
//   /quit or Ctrl+C  — exit
//
// Incoming messages are printed as they arrive. The relay uses the same
// newline-delimited JSON envelope protocol as agent-bus.ts.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let name = "human";
  let busRoot = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) name = args[++i];
    else if (args[i] === "--bus-root" && args[i + 1]) busRoot = path.resolve(args[++i]);
  }
  if (!busRoot) {
    busRoot = process.env.PI_AGENT_BUS_ROOT
      ? path.resolve(process.env.PI_AGENT_BUS_ROOT)
      : path.join(os.homedir(), ".pi-agent-bus", "default");
  }
  return { name, busRoot };
}

const { name, busRoot } = parseArgs();
const sockPath = path.join(busRoot, `${name}.sock`);

// ── Server (incoming messages) ────────────────────────────────────────────────

fs.mkdirSync(busRoot, { recursive: true });

function probeSocketLive(p, timeoutMs = 200) {
  return new Promise((resolve) => {
    const sock = net.connect(p);
    const done = (live) => { sock.removeAllListeners(); sock.destroy(); resolve(live); };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => { clearTimeout(t); done(true); });
    sock.once("error", () => { clearTimeout(t); done(false); });
  });
}

async function bindServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            // Wire format duplicates pi-sandbox/.pi/extensions/_lib/bus-envelope.ts
            // (TS, can't be imported from .mjs without porting). Keep in sync.
            const env = JSON.parse(line);
            if (env.v !== 2) continue;
            if (!env.payload || env.payload.kind !== "message" || typeof env.payload.text !== "string") continue;
            const reStr = env.in_reply_to ? ` re:${env.in_reply_to.slice(0, 8)}` : "";
            // Print above the prompt line
            rl.pause();
            process.stdout.write(`\r\x1b[K\x1b[33m[from ${env.from}${reStr}]\x1b[0m ${env.payload.text}\n`);
            rl.prompt(true);
            rl.resume();
          } catch { /* ignore */ }
        }
      });
      conn.on("error", () => conn.destroy());
    });

    const tryListen = () => new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(sockPath, () => { server.removeAllListeners("error"); res(); });
    });

    tryListen()
      .catch(async (e) => {
        if (e.code !== "EADDRINUSE") throw e;
        const live = await probeSocketLive(sockPath);
        if (live) throw new Error(`name "${name}" already held by a live peer`);
        fs.unlinkSync(sockPath);
        return tryListen();
      })
      .then(() => resolve(server))
      .catch(reject);
  });
}

// ── Send ──────────────────────────────────────────────────────────────────────

function sendTo(to, body, inReplyTo) {
  const dest = path.join(busRoot, `${to}.sock`);
  return new Promise((resolve) => {
    // Wire format duplicates pi-sandbox/.pi/extensions/_lib/bus-envelope.ts — keep in sync.
    const env = { v: 2, msg_id: randomUUID(), from: name, to, ts: Date.now(),
      payload: { kind: "message", text: body },
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}) };
    const sock = net.connect(dest);
    const done = (ok, reason) => { sock.removeAllListeners(); sock.destroy(); resolve({ ok, reason }); };
    const timer = setTimeout(() => done(false, "timeout"), 1000);
    sock.once("connect", () => {
      sock.write(`${JSON.stringify(env)}\n`, "utf8", () => { clearTimeout(timer); done(true); });
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      if (e.code === "ECONNREFUSED") try { fs.unlinkSync(dest); } catch { /* noop */ }
      done(false, e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "peer offline" : e.message);
    });
  });
}

async function listPeers() {
  let entries;
  try { entries = fs.readdirSync(busRoot); } catch { return []; }
  const peers = [];
  for (const f of entries.filter((f) => f.endsWith(".sock"))) {
    const peerName = f.slice(0, -5);
    const addr = path.join(busRoot, f);
    if (peerName === name || await probeSocketLive(addr)) peers.push(peerName);
    else try { fs.unlinkSync(addr); } catch { /* noop */ }
  }
  return peers;
}

// ── Main ──────────────────────────────────────────────────────────────────────

let server;
try {
  server = await bindServer();
} catch (e) {
  process.stderr.write(`human-relay: ${e.message}\n`);
  process.exit(1);
}

process.stderr.write(`human-relay: joined bus as "${name}" (${sockPath})\n`);
process.stderr.write(`  @<peer> <body>  — send to peer\n`);
process.stderr.write(`  <body>          — broadcast to all live peers\n`);
process.stderr.write(`  /peers          — list live peers\n`);
process.stderr.write(`  /quit           — exit\n\n`);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `\x1b[36m[${name}]>\x1b[0m `,
  terminal: true,
});

rl.prompt();

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) { rl.prompt(); return; }

  if (trimmed === "/quit" || trimmed === "/exit") {
    cleanup();
    process.exit(0);
  }

  if (trimmed === "/peers") {
    const peers = await listPeers();
    process.stdout.write(`Peers: ${peers.length === 0 ? "(none)" : peers.join(", ")}\n`);
    rl.prompt();
    return;
  }

  const match = trimmed.match(/^@(\S+)\s+([\s\S]+)$/);
  if (match) {
    const [, to, body] = match;
    const { ok, reason } = await sendTo(to, body);
    process.stdout.write(ok ? `  → sent to ${to}\n` : `  ✗ ${to}: ${reason}\n`);
  } else {
    // Broadcast
    const peers = (await listPeers()).filter((p) => p !== name);
    if (peers.length === 0) {
      process.stdout.write("  (no peers to broadcast to)\n");
    } else {
      await Promise.all(peers.map(async (to) => {
        const { ok, reason } = await sendTo(to, trimmed);
        process.stdout.write(ok ? `  → sent to ${to}\n` : `  ✗ ${to}: ${reason}\n`);
      }));
    }
  }
  rl.prompt();
});

rl.on("close", () => { cleanup(); process.exit(0); });

function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  try { fs.unlinkSync(sockPath); } catch { /* noop */ }
}

process.once("SIGINT", () => { process.stdout.write("\n"); cleanup(); process.exit(0); });
process.once("SIGTERM", () => { cleanup(); process.exit(0); });
process.once("exit", cleanup);
