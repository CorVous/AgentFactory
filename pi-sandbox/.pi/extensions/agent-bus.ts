// agent-bus extension — peer-to-peer messaging between independently
// launched pi agents. Each agent listens on a Unix domain socket at
// `${BUS_ROOT}/${name}.sock`. Messages are async fire-and-forget: a
// successful send returns immediately and the recipient surfaces the
// message on its next turn via pi.sendUserMessage. The same buffer is
// also pull-readable via the agent_inbox tool.
//
// busRoot and agentName are read from getHabitat() (materialised by the
// habitat baseline extension before this session_start runs). The
// resolution chain (--agent-bus → $PI_AGENT_BUS_ROOT → default) happens
// in scripts/run-agent.mjs and lands as Habitat.busRoot. The bus root
// deliberately lives outside scratchRoot so the sandbox extension's
// path rejection doesn't trip on socket paths; the bus extension only
// opens sockets, never invokes path-bearing tools, so the sandbox
// allowlist is unaffected.
//
// Wire format is the typed `Envelope` from `_lib/bus-envelope.ts`;
// envelope construction, encoding, decoding, and inbound rendering all
// route through that library.
//
// Companion to atomic-delegate. Atomic delegate uses the bus's submission
// flow internally; for explicit peer messaging, agents call agent_send /
// agent_call directly.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { getHabitat } from "./_lib/habitat";
import {
  encodeEnvelope,
  makeMessageEnvelope,
  renderInboundForUser,
  tryDecodeEnvelope,
  type Envelope,
} from "./_lib/bus-envelope";
import { dispatchSubmissionReply } from "./_lib/submission-emit";

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

// busRoot and agentName are resolved from the Habitat materialised by
// the habitat baseline extension before this session_start runs.

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
        const env = tryDecodeEnvelope(line);
        if (!env) continue; // drop malformed / wrong-version envelopes silently
        handleIncoming(state, env);
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
  // If this is a reply to a pending agent_call, resolve or reject it
  // directly — don't route to inbox, the caller is already waiting for it.
  if (env.in_reply_to) {
    const pending = state.pendingCalls.get(env.in_reply_to);
    if (pending) {
      clearTimeout(pending.timer);
      state.pendingCalls.delete(env.in_reply_to);
      if (env.payload.kind === "message") {
        pending.resolve(env.payload.text);
      } else {
        // agent_call is a message-only convenience; a non-message reply is
        // a programming error — reject loudly so the caller sees it.
        pending.reject(
          new Error(
            `agent_call expected a message-kind reply, got '${env.payload.kind}' (msg_id ${env.msg_id.slice(0, 8)})`,
          ),
        );
      }
      return;
    }
  }

  // If this is a reply to a pending submission (approval-result or
  // revision-requested), route it to the submission-emit dispatch and stop.
  if (env.in_reply_to && dispatchSubmissionReply(env)) return;

  // atomic-delegate hook: spawned workers send submissions FROM names
  // that don't appear in this agent's static acceptedFrom list. The
  // hook self-gates on its own pending-workers map and runs BEFORE the
  // acceptedFrom check so dynamic workers aren't dropped.
  const adHook = (
    globalThis as { __pi_atomic_delegate_dispatch__?: (env: Envelope) => boolean }
  ).__pi_atomic_delegate_dispatch__;
  if (adHook && adHook(env)) return;

  // Typed dispatch: non-message envelopes go to the supervisor rail when it
  // is loaded; message-kind envelopes always flow through the general inbox.
  const kind = env.payload.kind;

  if (kind !== "message") {
    // acceptedFrom enforcement for typed (non-message) inbound envelopes.
    // Message-kind envelopes are unrestricted for v1 peer chat.
    let acceptedFrom: string[] = [];
    try {
      acceptedFrom = getHabitat().acceptedFrom;
    } catch { /* Habitat not yet available — default to empty (drop) */ }
    if (!acceptedFrom.includes(env.from)) {
      if (process.env.AGENT_DEBUG === "1") {
        process.stderr.write(
          `[agent-bus] dropping ${kind} from '${env.from}': not in acceptedFrom\n`,
        );
      }
      return;
    }

    // Forward to supervisor rail when loaded.
    const dispatch = (
      globalThis as { __pi_supervisor_dispatch__?: (env: Envelope) => boolean }
    ).__pi_supervisor_dispatch__;
    if (dispatch && dispatch(env)) return;

    // No supervisor rail loaded — fall through to general inbox so the
    // message is still accessible via agent_inbox.
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
    try {
      state.pi.sendUserMessage(renderInboundForUser(env), { deliverAs: "followUp" });
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
      sock.write(encodeEnvelope(env), "utf8", () => {
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
  const state = getState();
  state.pi = pi;

  pi.on("session_start", async (_event, ctx) => {
    let name = "anonymous";
    let busRoot: string;
    try {
      const h = getHabitat();
      name = (h.agentName || "anonymous").trim() || "anonymous";
      busRoot = path.resolve(h.busRoot);
    } catch {
      // Habitat not available (direct pi invocation); fall back to ctx.cwd-derived defaults.
      name = (process.env.PI_AGENT_NAME || "anonymous").trim() || "anonymous";
      const sandboxRoot = path.resolve(ctx.cwd);
      busRoot = path.join(os.homedir(), ".pi-agent-bus", path.basename(sandboxRoot));
    }
    state.name = name;
    state.busRoot = busRoot;

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
      const env = makeMessageEnvelope({
        from: state.name,
        to: params.to,
        text: params.body,
        in_reply_to: params.in_reply_to,
      });
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
      const lines = matched.map((e) => {
        const text = e.payload.kind === "message" ? e.payload.text : `(${e.payload.kind})`;
        return `[${new Date(e.ts).toISOString()}] ${e.from} → ${e.to} (${e.msg_id.slice(0, 8)}): ${text}`;
      });
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
      const env = makeMessageEnvelope({
        from: state.name,
        to: params.to,
        text: params.body,
      });

      const result = await sendEnvelope(state, env);
      if (!result.delivered) {
        return {
          content: [{ type: "text", text: `agent_call to ${params.to} failed: ${result.reason}.` }],
          details: { msg_id: env.msg_id, delivered: false, reason: result.reason },
        };
      }

      let timedOut = false;
      let typeMismatchError: string | undefined;
      const replyBody = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          state.pendingCalls.delete(env.msg_id);
          reject(new Error("timeout"));
        }, timeoutMs);
        state.pendingCalls.set(env.msg_id, { resolve, reject, timer });
      }).catch((err: Error) => {
        if (!timedOut) typeMismatchError = err.message;
        return "";
      });

      if (timedOut) {
        return {
          content: [{ type: "text", text: `agent_call to ${params.to} timed out after ${timeoutMs}ms.` }],
          details: { msg_id: env.msg_id, delivered: true, reply: null, reason: "timeout" },
        };
      }
      if (typeMismatchError) {
        return {
          content: [{ type: "text", text: `agent_call to ${params.to} failed: ${typeMismatchError}` }],
          details: { msg_id: env.msg_id, delivered: true, reply: null, reason: typeMismatchError },
        };
      }
      return {
        content: [{ type: "text", text: `Reply from ${params.to}: ${replyBody}` }],
        details: { msg_id: env.msg_id, delivered: true, reply: replyBody },
      };
    },
  });
}
