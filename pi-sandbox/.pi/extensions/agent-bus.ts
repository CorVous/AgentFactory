// agent-bus extension — peer-to-peer messaging between independently
// launched pi agents. Each agent listens on a Unix domain socket at
// `${BUS_ROOT}/${name}.sock`. Messages are async fire-and-forget: a
// successful send returns immediately and the recipient surfaces the
// message on its next turn via pi.sendUserMessage. The same buffer is
// also pull-readable via the agent_inbox tool.
//
// Bus root resolution: --agent-bus-root flag → $PI_AGENT_BUS_ROOT →
// ~/.pi-agent-bus/<basename(sandbox-root)>. Deliberately lives outside
// --sandbox-root so the sandbox extension's path rejection doesn't trip.
// The bus extension only opens sockets, never invokes path-bearing
// built-in tools, so the sandbox allowlist is unaffected.
//
// Companion to agent-spawn (blocking delegation). The two are
// orthogonal: a recipe loads either, both, or neither.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

interface Envelope {
  v: 1;
  msg_id: string;
  from: string;
  to: string;
  ts: number;
  body: string;
  in_reply_to?: string;
}

interface PendingCall {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BusState {
  server?: net.Server;
  sockPath?: string;
  name: string;
  busRoot: string;
  inbox: Envelope[];
  pendingDuringTurn: Envelope[];
  inTurn: boolean;
  pi?: ExtensionAPI;
  pendingCalls: Map<string, PendingCall>;
}

// Stash on globalThis so any second import of this module (jiti loads
// extensions in isolated module graphs) sees the same state — same
// pattern as deferred-confirm.
function getState(): BusState {
  const g = globalThis as { __pi_agent_bus__?: BusState };
  return (g.__pi_agent_bus__ ??= {
    name: "",
    busRoot: "",
    inbox: [],
    pendingDuringTurn: [],
    inTurn: false,
    pendingCalls: new Map(),
  });
}

function resolveBusRoot(pi: ExtensionAPI, sandboxRoot: string): string {
  const flag = pi.getFlag("agent-bus-root") as string | undefined;
  if (flag) return path.resolve(flag);
  // PI_AGENT_BUS_ROOT is also honored by the runner; reading it here
  // covers the case where pi was launched directly without the runner.
  if (process.env.PI_AGENT_BUS_ROOT) return path.resolve(process.env.PI_AGENT_BUS_ROOT);
  return path.join(os.homedir(), ".pi-agent-bus", path.basename(sandboxRoot));
}

function probeSocketLive(sockPath: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    const done = (live: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

async function bindServer(state: BusState, ctx: { ui: { notify: (m: string, l?: string) => void } }) {
  const sockPath = path.join(state.busRoot, `${state.name}.sock`);
  state.sockPath = sockPath;
  fs.mkdirSync(state.busRoot, { recursive: true });

  const server = net.createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const env = JSON.parse(line) as Envelope;
          if (env.v !== 1 || typeof env.from !== "string" || typeof env.body !== "string") continue;
          handleIncoming(state, env);
        } catch {
          // ignore malformed lines
        }
      }
    });
    conn.on("error", () => conn.destroy());
  });

  const tryListen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => {
        server.removeAllListeners("error");
        resolve();
      });
    });

  try {
    await tryListen();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EADDRINUSE") throw e;
    const live = await probeSocketLive(sockPath);
    if (live) {
      ctx.ui.notify(
        `agent-bus: name "${state.name}" already held by a live peer at ${sockPath} — refusing to bind`,
        "error",
      );
      throw new Error(`agent-bus name collision: ${state.name}`);
    }
    fs.unlinkSync(sockPath);
    await tryListen();
  }

  state.server = server;
}

function handleIncoming(state: BusState, env: Envelope) {
  // If this is a reply to a pending agent_call, resolve the blocked tool
  // directly — don't route to inbox, the caller is already waiting for it.
  if (env.in_reply_to) {
    const pending = state.pendingCalls.get(env.in_reply_to);
    if (pending) {
      clearTimeout(pending.timer);
      state.pendingCalls.delete(env.in_reply_to);
      pending.resolve(env.body);
      return;
    }
  }
  state.inbox.push(env);
  if (state.inTurn) {
    state.pendingDuringTurn.push(env);
    return;
  }
  pushToModel(state, [env]);
}

function pushToModel(state: BusState, envs: Envelope[]) {
  if (!state.pi) return;
  for (const env of envs) {
    const text = `[from ${env.from}${env.in_reply_to ? ` re:${env.in_reply_to.slice(0, 8)}` : ""}] ${env.body}`;
    try {
      state.pi.sendUserMessage(text, { deliverAs: "followUp" });
    } catch {
      // best-effort; the message is still in inbox for pull
    }
  }
}

async function sendEnvelope(state: BusState, env: Envelope): Promise<{ delivered: boolean; reason?: string }> {
  const dest = path.join(state.busRoot, `${env.to}.sock`);
  return new Promise((resolve) => {
    const sock = net.connect(dest);
    const done = (r: { delivered: boolean; reason?: string }) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ delivered: false, reason: "timeout" }), 1000);
    sock.once("connect", () => {
      sock.write(`${JSON.stringify(env)}\n`, "utf8", () => {
        clearTimeout(timer);
        done({ delivered: true });
      });
    });
    sock.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const reason =
        e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "peer offline" : `socket error: ${e.message}`;
      if (e.code === "ECONNREFUSED") {
        // dead sock left by a crashed peer; opportunistic cleanup
        try {
          fs.unlinkSync(dest);
        } catch {
          /* noop */
        }
      }
      done({ delivered: false, reason });
    });
  });
}

async function listLivePeers(state: BusState): Promise<{ name: string; addr: string }[]> {
  let entries: string[];
  try {
    entries = fs.readdirSync(state.busRoot);
  } catch {
    return [];
  }
  const candidates = entries.filter((f) => f.endsWith(".sock")).map((f) => f.slice(0, -".sock".length));
  const results: { name: string; addr: string }[] = [];
  for (const peerName of candidates) {
    const addr = path.join(state.busRoot, `${peerName}.sock`);
    if (peerName === state.name) {
      results.push({ name: peerName, addr });
      continue;
    }
    if (await probeSocketLive(addr)) {
      results.push({ name: peerName, addr });
    } else {
      try {
        fs.unlinkSync(addr);
      } catch {
        /* noop */
      }
    }
  }
  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("agent-bus-root", {
    description: "Rendezvous directory for inter-agent Unix sockets (one .sock per agent name)",
    type: "string",
  });

  const state = getState();
  state.pi = pi;

  pi.on("session_start", async (_event, ctx) => {
    // pi.getFlag is scoped to the calling extension, so reading flags
    // owned by sandbox/agent-header doesn't work cross-extension. The
    // runner mirrors agent-name into PI_AGENT_NAME for us; sandbox-root
    // equals ctx.cwd because the runner spawns pi with cwd=sandboxRoot.
    const name = (process.env.PI_AGENT_NAME || "anonymous").trim() || "anonymous";
    const sandboxRoot = path.resolve(ctx.cwd);
    state.name = name;
    state.busRoot = resolveBusRoot(pi, sandboxRoot);

    try {
      await bindServer(state, ctx);
    } catch (e) {
      ctx.ui.notify(`agent-bus: failed to bind ${state.sockPath}: ${(e as Error).message}`, "error");
      return;
    }

    if (process.env.AGENT_DEBUG === "1") {
      const dump = `agent-bus: name=${state.name} sock=${state.sockPath}`;
      ctx.ui.notify(dump, "info");
      process.stderr.write(`[AGENT_DEBUG] ${dump}\n`);
    }

    // Inject the initial task (set by launch-mesh or mesh_spawn) as the
    // first user turn. Delivered as followUp so session_start finishes first.
    const initialTask = process.env.PI_MESH_INITIAL_TASK;
    if (initialTask) {
      state.pi?.sendUserMessage(initialTask, { deliverAs: "followUp" });
    }
  });

  pi.on("turn_start", async () => {
    state.inTurn = true;
  });

  pi.on("turn_end", async () => {
    state.inTurn = false;
    if (state.pendingDuringTurn.length === 0) return;
    const drained = state.pendingDuringTurn.splice(0);
    pushToModel(state, drained);
  });

  const cleanup = () => {
    for (const [, pending] of state.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("agent-bus shutdown"));
    }
    state.pendingCalls.clear();
    if (state.server) {
      try {
        state.server.close();
      } catch {
        /* noop */
      }
      state.server = undefined;
    }
    if (state.sockPath) {
      try {
        fs.unlinkSync(state.sockPath);
      } catch {
        /* noop */
      }
    }
  };
  pi.on("session_shutdown", async () => cleanup());
  process.once("exit", cleanup);

  pi.registerTool({
    name: "agent_send",
    label: "Agent Send",
    description:
      "Send an async message to another agent on the bus. Fire-and-forget: " +
      "returns once the byte hits the wire (or fails). The recipient receives " +
      "the message as a synthetic user prompt on its next turn (and via " +
      "agent_inbox). Use agent_list to discover live peers.",
    parameters: Type.Object({
      to: Type.String({ description: "Name of the recipient agent (matches its --agent-name)." }),
      body: Type.String({ description: "Message body. Plain text; no envelope wrapping required." }),
      in_reply_to: Type.Optional(
        Type.String({ description: "Optional msg_id of the message you are replying to." }),
      ),
    }),
    async execute(_id, params) {
      if (!state.server) {
        return {
          content: [{ type: "text", text: "agent-bus not initialized; cannot send." }],
          details: { delivered: false, reason: "bus not initialized" },
        };
      }
      const env: Envelope = {
        v: 1,
        msg_id: randomUUID(),
        from: state.name,
        to: params.to,
        ts: Date.now(),
        body: params.body,
        ...(params.in_reply_to ? { in_reply_to: params.in_reply_to } : {}),
      };
      const result = await sendEnvelope(state, env);
      const text = result.delivered
        ? `Sent to ${params.to} (msg_id ${env.msg_id.slice(0, 8)}).`
        : `Send to ${params.to} failed: ${result.reason}.`;
      return {
        content: [{ type: "text", text }],
        details: { msg_id: env.msg_id, delivered: result.delivered, reason: result.reason },
      };
    },
  });

  pi.registerTool({
    name: "agent_inbox",
    label: "Agent Inbox",
    description:
      "Read messages buffered by the bus. By default returned messages are " +
      "cleared from the inbox; pass peek=true to keep them. Use since_ts to " +
      "filter to messages newer than a given epoch ms.",
    parameters: Type.Object({
      since_ts: Type.Optional(Type.Number({ description: "Only return messages with ts >= this value." })),
      peek: Type.Optional(Type.Boolean({ description: "If true, do not clear returned messages from the inbox." })),
    }),
    async execute(_id, params) {
      const since = typeof params.since_ts === "number" ? params.since_ts : 0;
      const matched = state.inbox.filter((e) => e.ts >= since);
      if (!params.peek) {
        const remaining = state.inbox.filter((e) => e.ts < since);
        state.inbox.length = 0;
        state.inbox.push(...remaining);
      }
      const lines = matched.map(
        (e) => `[${new Date(e.ts).toISOString()}] ${e.from} → ${e.to} (${e.msg_id.slice(0, 8)}): ${e.body}`,
      );
      return {
        content: [{ type: "text", text: lines.length === 0 ? "(inbox empty)" : lines.join("\n") }],
        details: { count: matched.length, messages: matched },
      };
    },
  });

  pi.registerTool({
    name: "agent_list",
    label: "Agent List",
    description: "List currently-live peers on the bus (probes each socket; cleans stale entries).",
    parameters: Type.Object({}),
    async execute() {
      const peers = await listLivePeers(state);
      const lines = peers.map((p) => `${p.name}${p.name === state.name ? " (self)" : ""} — ${p.addr}`);
      return {
        content: [{ type: "text", text: lines.length === 0 ? "(no peers)" : lines.join("\n") }],
        details: { peers },
      };
    },
  });

  pi.registerTool({
    name: "agent_call",
    label: "Agent Call",
    description:
      "Send a message to a peer and block until it replies. Unlike agent_send " +
      "(fire-and-forget), agent_call waits for the recipient to send back a message " +
      "with in_reply_to matching the outgoing msg_id. Returns the reply body. Use " +
      "for request-response exchanges where you need the answer before continuing. " +
      "The recipient must call agent_send({to, body, in_reply_to: <msg_id>}) to unblock " +
      "the caller. Fails fast if the peer is offline. Default timeout is 30 s.",
    parameters: Type.Object({
      to: Type.String({ description: "Name of the recipient agent." }),
      body: Type.String({ description: "Request body." }),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Max wait in ms for a reply. Default 30000." }),
      ),
    }),
    async execute(_id, params) {
      if (!state.server) {
        return {
          content: [{ type: "text", text: "agent-bus not initialized; cannot call." }],
          details: { delivered: false, reason: "bus not initialized" },
        };
      }
      const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 30_000;
      const env: Envelope = {
        v: 1,
        msg_id: randomUUID(),
        from: state.name,
        to: params.to,
        ts: Date.now(),
        body: params.body,
      };

      const result = await sendEnvelope(state, env);
      if (!result.delivered) {
        return {
          content: [{ type: "text", text: `agent_call to ${params.to} failed: ${result.reason}.` }],
          details: { msg_id: env.msg_id, delivered: false, reason: result.reason },
        };
      }

      let timedOut = false;
      const replyBody = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          state.pendingCalls.delete(env.msg_id);
          reject(new Error("timeout"));
        }, timeoutMs);
        state.pendingCalls.set(env.msg_id, { resolve, reject, timer });
      }).catch(() => "");

      if (timedOut) {
        return {
          content: [{ type: "text", text: `agent_call to ${params.to} timed out after ${timeoutMs}ms.` }],
          details: { msg_id: env.msg_id, delivered: true, reply: null, reason: "timeout" },
        };
      }
      return {
        content: [{ type: "text", text: `Reply from ${params.to}: ${replyBody}` }],
        details: { msg_id: env.msg_id, delivered: true, reply: replyBody },
      };
    },
  });
}
