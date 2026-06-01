// peer-bus extension — peer-to-peer messaging between independently
// launched pi agents. Each agent listens on a Unix domain socket at
// `${BUS_ROOT}/${name}.sock`. Messages are async fire-and-forget: a
// successful send returns immediately and the recipient surfaces the
// message on its next turn via pi.sendUserMessage. The same buffer is
// also pull-readable via the peer_inbox tool.
//
// busRoot and instanceName are read from getHabitat() (materialised by the
// habitat baseline extension before this session_start runs). The
// resolution chain (--peer-bus → default) is resolved by the engine's
// recipe-loader and lands as Habitat.busRoot. The bus root
// deliberately lives outside scratchRoot so the sandbox extension's
// path rejection doesn't trip on socket paths; the bus extension only
// opens sockets, never invokes path-bearing tools, so the sandbox
// allowlist is unaffected.
//
// Wire format is the typed `Envelope` from `../lib/bus-envelope.ts`;
// envelope construction, encoding, decoding, and inbound rendering all
// route through that library.
//
// Companion to mesh-spawn. Workers spawned via mesh_spawn communicate over
// this bus; for explicit peer messaging, agents call peer_send / peer_call
// directly.
//
// LAZY ACQUISITION: socket binding is gated on habitatHasPeers(). A solo
// pi --recipe run (no peers) binds no OS socket; mesh tools are still
// registered unconditionally so recipe allowlists resolve.

import os from "node:os";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getHabitat } from "../lib/habitat.js";
import {
  encodeEnvelope,
  makeMessageEnvelope,
  renderInboundForUser,
  tryDecodeEnvelope,
  type Envelope,
} from "../lib/bus-envelope.js";
import { dispatchSubmissionReply } from "../lib/submission-emit.js";
import { createUnixSocketTransport, type BusTransport } from "../lib/bus-transport.js";
import { habitatHasPeers } from "../lib/mesh-peering.js";
import {
  ingestMeshUpdate,
  expandGroupRef,
  getCohortLookupHook,
  needsLookup,
} from "../lib/cohort-tracker.js";
import { parseRef } from "../lib/peer-spawn.js";
import type { GroupMap } from "../lib/cohort-registry.js";

interface PendingCall {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BusState {
  transport?: BusTransport;
  bound: boolean;
  name: string;
  busRoot: string;
  inbox: Envelope[];
  pendingDuringTurn: Envelope[];
  inTurn: boolean;
  pi?: ExtensionAPI;
  pendingCalls: Map<string, PendingCall>;
  // Slice 3 (ADR-0008): cohort cache for group-ref expansion + visibility
  cohortCache: GroupMap;
  /** Declared group memberships for this peer (seeded from Habitat.groups). */
  selfGroups: string[];
  /** The spawner's instance name (seeded from Habitat.spawnerName). */
  spawnerName: string;
}

// Stash on globalThis so any second import of this module (jiti loads
// extensions in isolated module graphs) sees the same state — same
// pattern as deferred-confirm.
function getState(): BusState {
  const g = globalThis as { __pi_peer_bus__?: BusState };
  return (g.__pi_peer_bus__ ??= {
    bound: false,
    name: "",
    busRoot: "",
    inbox: [],
    pendingDuringTurn: [],
    inTurn: false,
    pendingCalls: new Map(),
    cohortCache: new Map(),
    selfGroups: [],
    spawnerName: "",
  });
}

// busRoot and instanceName are resolved from the Habitat materialised by
// the habitat baseline extension before this session_start runs.

function notifyBusTailObserver(env: Envelope, direction: "in" | "out") {
  const observer = (
    globalThis as { __pi_bus_tail_observe__?: (env: Envelope, direction: "in" | "out") => void }
  ).__pi_bus_tail_observe__;
  if (observer) {
    try { observer(env, direction); } catch { /* ignore observer errors */ }
  }
}

function handleIncoming(state: BusState, env: Envelope) {
  // Notify the bus-tail observer (if installed by bus-tail-emitter extension).
  notifyBusTailObserver(env, "in");

  // If this is a reply to a pending peer_call, resolve or reject it
  // directly — don't route to inbox, the caller is already waiting for it.
  if (env.in_reply_to) {
    const pending = state.pendingCalls.get(env.in_reply_to);
    if (pending) {
      clearTimeout(pending.timer);
      state.pendingCalls.delete(env.in_reply_to);
      if (env.payload.kind === "message") {
        pending.resolve(env.payload.text);
      } else {
        // peer_call is a message-only convenience; a non-message reply is
        // a programming error — reject loudly so the caller sees it.
        pending.reject(
          new Error(
            `peer_call expected a message-kind reply, got '${env.payload.kind}' (msg_id ${env.msg_id.slice(0, 8)})`,
          ),
        );
      }
      return;
    }
  }

  // If this is a reply to a pending submission (approval-result or
  // revision-requested), route it to the submission-emit dispatch and stop.
  if (env.in_reply_to && dispatchSubmissionReply(env)) return;

  // Typed dispatch: non-message envelopes go to the supervisor rail when it
  // is loaded; message-kind envelopes always flow through the general inbox.
  const kind = env.payload.kind;

  // mesh-update envelopes BYPASS the acceptsWorkFrom gate and are NEVER
  // surfaced to the model — they update the local cohort cache and return.
  // This branch runs BEFORE the acceptsWorkFrom check (same ordering as shutdown).
  if (kind === "mesh-update") {
    const p = env.payload;
    if (p.kind === "mesh-update") {
      ingestMeshUpdate(state.cohortCache, { spawner: p.spawner, changes: p.changes });
    }
    return;
  }

  // shutdown envelopes BYPASS the acceptsWorkFrom gate — a spawner killing its
  // worker may not be in the worker's acceptsWorkFrom list (the worker's overlay
  // only sets acceptsWorkFrom to the spawner for submissions/approvals, but
  // mesh_kill sends a shutdown that must still be honoured).
  if (kind === "shutdown") {
    // Best-effort graceful shutdown: abort the current turn if possible, then exit.
    const api = state.pi as unknown as
      | { abort?: () => void; shutdown?: () => void }
      | undefined;
    try {
      api?.abort?.();
    } catch { /* noop */ }
    setTimeout(() => {
      try {
        if (api?.shutdown) {
          api.shutdown();
        } else {
          process.exit(0);
        }
      } catch {
        process.exit(0);
      }
    }, 0);
    return;
  }

  if (kind !== "message") {
    // acceptsWorkFrom enforcement for typed (non-message) inbound envelopes.
    // Message-kind envelopes are unrestricted for v1 peer chat.
    // Dynamic workers spawned via mesh_spawn are admitted via the
    // __pi_mesh_spawn_is_my_worker__ predicate even if they aren't in the
    // static acceptsWorkFrom list (they're in our registry so we know them).
    let acceptsWorkFrom: string[] = [];
    try {
      acceptsWorkFrom = getHabitat().acceptsWorkFrom;
    } catch { /* Habitat not yet available — default to empty (drop) */ }
    const meshSpawnPredicate = (
      globalThis as { __pi_mesh_spawn_is_my_worker__?: (name: string) => boolean }
    ).__pi_mesh_spawn_is_my_worker__;
    const isMyWorker = meshSpawnPredicate ? meshSpawnPredicate(env.from) : false;
    if (!acceptsWorkFrom.includes(env.from) && !isMyWorker) {
      try {
        if (getHabitat().debug === true) {
          process.stderr.write(
            `[peer-bus] dropping ${kind} from '${env.from}': not in acceptsWorkFrom\n`,
          );
        }
      } catch { /* Habitat not yet available */ }
      return;
    }

    // Forward to supervisor rail when loaded.
    const dispatch = (
      globalThis as { __pi_supervisor_dispatch__?: (env: Envelope) => boolean }
    ).__pi_supervisor_dispatch__;
    if (dispatch && dispatch(env)) return;

    // No supervisor rail loaded — fall through to general inbox so the
    // message is still accessible via peer_inbox.
  }

  state.inbox.push(env);
  if (state.inTurn) {
    state.pendingDuringTurn.push(env);
    return;
  }
  pushToModel(state, [env]);

  // Unknown-sender seam (ADR-0008): if the sender is not yet in our cohort
  // cache, fire the host lookup hook asynchronously so Slice 4's mesh-mux
  // can backfill the cache. The no-op default resolver returns null.
  if (needsLookup(state.cohortCache, env.from)) {
    const hook = getCohortLookupHook();
    hook(env.from).then((result) => {
      if (result) {
        ingestMeshUpdate(state.cohortCache, {
          spawner: state.spawnerName || env.from,
          changes: [{ peer: env.from, recipe: result.recipe, groups: result.groups, op: "add" }],
        });
      }
    }).catch(() => { /* best-effort */ });
  }
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
  // Delegate send (including opportunistic offline-socket cleanup) to the transport.
  const result = await state.transport!.send(env.to, encodeEnvelope(env));
  // Notify the bus-tail observer on successful outbound delivery.
  // notifyBusTailObserver needs the Envelope object, so it stays in the extension.
  if (result.delivered) notifyBusTailObserver(env, "out");
  return result;
}

export default function (pi: ExtensionAPI) {
  const state = getState();
  state.pi = pi;

  pi.on("session_start", async (_event, ctx) => {
    let name = "anonymous";
    let busRoot: string;
    let hasPeers = false;
    try {
      const h = getHabitat();
      name = (h.instanceName || "anonymous").trim() || "anonymous";
      busRoot = path.resolve(h.busRoot);
      hasPeers = habitatHasPeers(h);
      // Slice 3: seed cohort context from Habitat
      state.selfGroups = Array.isArray(h.groups) ? h.groups.slice() : [];
      state.spawnerName = h.spawnerName ?? "";
    } catch {
      // Habitat not available (direct pi invocation); fall back to ctx.cwd-derived defaults.
      name = "anonymous";
      const sandboxRoot = path.resolve(ctx.cwd);
      busRoot = path.join(os.homedir(), ".pi-agent-bus", path.basename(sandboxRoot));
    }
    state.name = name;
    state.busRoot = busRoot!;

    // LAZY ACQUISITION: skip socket binding for solo runs (no peers configured).
    // Tools are already registered unconditionally; they return "bus not initialized"
    // when state.transport/state.bound is unset, which is the correct behavior for solo mode.
    if (!hasPeers) return;

    state.transport = createUnixSocketTransport(busRoot!);

    const onLine = (line: string) => {
      const env = tryDecodeEnvelope(line);
      if (!env) return; // drop malformed / wrong-version envelopes silently
      handleIncoming(state, env);
    };

    try {
      await state.transport.listen(state.name, onLine);
      state.bound = true;
    } catch (e) {
      const msg = (e as Error).message;
      // Re-surface the collision message exactly as before, or fall back to generic.
      ctx.ui.notify(
        msg.startsWith("peer-bus name collision:")
          ? `peer-bus: name "${state.name}" already held by a live peer — refusing to bind`
          : `peer-bus: failed to bind for ${state.name}: ${msg}`,
        "error",
      );
      return;
    }

    try {
      if (getHabitat().debug === true) {
        const sockPath = path.join(busRoot!, `${state.name}.sock`);
        const dump = `peer-bus: name=${state.name} sock=${sockPath}`;
        ctx.ui.notify(dump, "info");
        process.stderr.write(`[peer-bus] ${dump}\n`);
      }
    } catch { /* Habitat not available */ }

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
      pending.reject(new Error("peer-bus shutdown"));
    }
    state.pendingCalls.clear();
    state.transport?.closeSync();
    state.transport = undefined;
    state.bound = false;
  };
  pi.on("session_shutdown", async () => cleanup());
  process.once("exit", cleanup);

  pi.registerTool({
    name: "peer_send",
    label: "Peer Send",
    description:
      "Send an async message to another peer (or a group ref) on the bus. " +
      "Fire-and-forget: returns once the byte hits the wire (or fails). The " +
      "recipient receives the message as a synthetic user prompt on its next " +
      "turn (and via peer_inbox). `to` may be a literal peer name or a group " +
      "reference (@<group>, @$myGroups, @<group>:<recipe>, etc.); group refs " +
      "expand locally to N point-to-point envelopes. Use peer_list to discover " +
      "live peers.",
    parameters: Type.Object({
      to: Type.String({
        description:
          "Name of the recipient peer (matches its --peer-name) OR a group " +
          "reference (e.g. @haiku, @$myGroups). Group refs fan out to all " +
          "members known in the local cohort cache.",
      }),
      body: Type.String({ description: "Message body. Plain text; no envelope wrapping required." }),
      in_reply_to: Type.Optional(
        Type.String({ description: "Optional msg_id of the message you are replying to." }),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!state.transport || !state.bound) {
        return {
          content: [{ type: "text", text: "peer-bus not initialized; cannot send." }],
          details: { delivered: false, reason: "bus not initialized" },
        };
      }

      // Parse the `to` field to check if it is a group ref
      let parsed;
      try {
        parsed = parseRef(params.to);
      } catch (e) {
        return {
          content: [{ type: "text", text: `peer_send: invalid ref '${params.to}': ${(e as Error).message}` }],
          details: { delivered: false, reason: "invalid_ref" },
        };
      }

      if (parsed.kind === "literal") {
        // Single-target path (original behavior)
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
      }

      // Group ref path: expand to peer names via the cohort cache
      const targets = expandGroupRef(state.cohortCache, state.selfGroups, params.to);
      if (targets.length === 0) {
        return {
          content: [{ type: "text", text: `peer_send: group ref '${params.to}' expanded to zero targets (no members in cohort cache).` }],
          details: { delivered: false, reason: "empty_group", fanout: [] },
        };
      }

      const fanout: Array<{ to: string; delivered: boolean; msg_id: string; reason?: string }> = [];
      for (const target of targets) {
        const env = makeMessageEnvelope({
          from: state.name,
          to: target,
          text: params.body,
          in_reply_to: params.in_reply_to,
        });
        const result = await sendEnvelope(state, env);
        fanout.push({ to: target, delivered: result.delivered, msg_id: env.msg_id, reason: result.reason });
      }

      const delivered = fanout.filter((r) => r.delivered).length;
      const text = `Sent to ${delivered}/${fanout.length} targets via '${params.to}': ${fanout.map((r) => `${r.to}=${r.delivered ? "ok" : r.reason}`).join(", ")}.`;
      return {
        content: [{ type: "text", text }],
        details: { delivered: delivered > 0, fanout },
      };
    },
  });

  pi.registerTool({
    name: "peer_inbox",
    label: "Peer Inbox",
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
    name: "peer_list",
    label: "Peer List",
    description: "List currently-live peers on the bus (probes each socket; cleans stale entries).",
    parameters: Type.Object({}),
    async execute() {
      const peers = await (state.transport
        ? state.transport.discover(state.name)
        : Promise.resolve([]));
      const lines = peers.map((p) => `${p.name}${p.name === state.name ? " (self)" : ""} — ${p.addr}`);
      return {
        content: [{ type: "text", text: lines.length === 0 ? "(no peers)" : lines.join("\n") }],
        details: { peers },
      };
    },
  });

  pi.registerTool({
    name: "peer_call",
    label: "Peer Call",
    description:
      "Send a message to a peer and block until it replies. Unlike peer_send " +
      "(fire-and-forget), peer_call waits for the recipient to send back a message " +
      "with in_reply_to matching the outgoing msg_id. Returns the reply body. Use " +
      "for request-response exchanges where you need the answer before continuing. " +
      "The recipient must call peer_send({to, body, in_reply_to: <msg_id>}) to unblock " +
      "the caller. Fails fast if the peer is offline. Default timeout is 30 s.",
    parameters: Type.Object({
      to: Type.String({ description: "Name of the recipient agent." }),
      body: Type.String({ description: "Request body." }),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Max wait in ms for a reply. Default 30000." }),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!state.transport || !state.bound) {
        return {
          content: [{ type: "text", text: "peer-bus not initialized; cannot call." }],
          details: { delivered: false, reason: "bus not initialized" },
        };
      }

      // peer_call is literal-only — reject group refs with a clear error.
      let parsedTo;
      try {
        parsedTo = parseRef(params.to);
      } catch (e) {
        return {
          content: [{ type: "text", text: `peer_call: invalid ref '${params.to}': ${(e as Error).message}` }],
          details: { delivered: false, reason: "invalid_ref" },
        };
      }
      if (parsedTo.kind !== "literal") {
        return {
          content: [{ type: "text", text: `peer_call: group references are not supported; use a literal peer name. Got '${params.to}'.` }],
          details: { delivered: false, reason: "group_ref_not_allowed" },
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
          content: [{ type: "text", text: `peer_call to ${params.to} failed: ${result.reason}.` }],
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
          content: [{ type: "text", text: `peer_call to ${params.to} timed out after ${timeoutMs}ms.` }],
          details: { msg_id: env.msg_id, delivered: true, reply: null, reason: "timeout" },
        };
      }
      if (typeMismatchError) {
        return {
          content: [{ type: "text", text: `peer_call to ${params.to} failed: ${typeMismatchError}` }],
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
