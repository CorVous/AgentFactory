// agent-receive — child-side companion to agent-view. Lets a human
// who's "switched into" this child via /view at the parent level:
//
//   1. Forward user-typed messages into this child as new user turns
//      (`{type: "user-message", body}` → pi.sendUserMessage(body)).
//   2. Keep the child alive past natural turn-end while the human is
//      watching (`{type: "start-takeover"}` parks the child at
//      agent_end on a never-resolving Promise; `{type: "release"}`
//      flips it back so the next agent_end exits cleanly).
//
// Opens its OWN connection to the parent's per-call RPC socket
// (separate from agent-status-reporter's status-pushing conn) and
// tags it with `{type: "hello", id, role: "control"}`. The parent's
// agent-spawn extension recognizes the role and stores the conn on
// its registry entry as `controlConn`; agent-view writes user-message
// / start-takeover / release envelopes to that conn.
//
// No-ops for top-level (non-delegated) runs — same gating idiom as
// agent-status-reporter / requestHumanApproval. A child that wasn't
// spawned by agent-spawn has no PI_RPC_SOCK and no PI_AGENT_DELEGATION_ID.
//
// Failure semantics: best-effort. The control conn is non-essential —
// the child runs to completion as it would today even if /view never
// connects, the conn drops, or the parent ignores it. No retries.

import net from "node:net";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ReceiveRuntime {
  sock: net.Socket | null;
  // Default `true`: the child exits at natural turn-end. /view sends
  // `start-takeover` to flip this false; /back sends `release` to flip
  // it back true.
  released: boolean;
  // Resolves when `released` flips to true. Recreated each time we
  // park at agent_end. Lets the parked Promise resolve immediately
  // when the parent sends release without waiting for a new envelope.
  releaseGate: { promise: Promise<void>; resolve: () => void } | null;
  delegationId: string;
  giveUp: boolean;
}

function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function attachSocket(rt: ReceiveRuntime, sockPath: string, pi: ExtensionAPI): void {
  if (rt.giveUp) return;
  const sock = net.connect(sockPath);
  rt.sock = sock;
  let buf = "";

  sock.setEncoding("utf8");
  sock.once("connect", () => {
    try {
      // Tag the conn so agent-spawn stores it as `controlConn` instead
      // of treating it as a status-only connection. Sent before any
      // other envelope so the parent's hello-handler runs first.
      sock.write(JSON.stringify({ type: "hello", id: rt.delegationId, role: "control" }) + "\n");
    } catch {
      /* parent died before handshake; nothing we can do */
    }
  });

  sock.on("data", (chunk: string) => {
    buf += chunk;
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as { type?: string; body?: unknown };
        if (msg.type === "user-message" && typeof msg.body === "string" && msg.body.length > 0) {
          // Queue the human's message into the child's next turn. pi
          // dispatches it the same way it dispatches a CLI prompt or
          // a /command's pi.sendUserMessage call.
          try {
            pi.sendUserMessage(msg.body);
          } catch {
            /* best-effort; if pi rejects, the parent will see no
               new turn and can decide what to do */
          }
          continue;
        }
        if (msg.type === "start-takeover") {
          rt.released = false;
          continue;
        }
        if (msg.type === "release") {
          rt.released = true;
          // Wake up any agent_end currently parked.
          rt.releaseGate?.resolve();
          rt.releaseGate = null;
          continue;
        }
      } catch {
        /* malformed envelope; ignore */
      }
    }
  });

  // Drop the socket on error/close. We do NOT reconnect: if the parent
  // died, the takeover is moot and the child should exit at the next
  // natural turn-end. Flip released back to true so we don't park
  // forever waiting for a release that will never come.
  const giveUp = () => {
    rt.released = true;
    rt.releaseGate?.resolve();
    rt.releaseGate = null;
    rt.sock = null;
    rt.giveUp = true;
  };
  sock.once("error", giveUp);
  sock.once("close", giveUp);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, _ctx) => {
    // Same gating as agent-status-reporter: no parent → no-op.
    const sockPath = (process.env.PI_RPC_SOCK || "").trim();
    if (!sockPath) return;
    const delegationId = (process.env.PI_AGENT_DELEGATION_ID || "").trim();
    if (!delegationId) return;

    const rt: ReceiveRuntime = {
      sock: null,
      released: true,
      releaseGate: null,
      delegationId,
      giveUp: false,
    };

    attachSocket(rt, sockPath, pi);

    // Park the child at agent_end while a human is in takeover mode.
    // This runs AFTER deferred-confirm's agent_end (which forwards
    // any pending approval and applies drafts) because pi fires
    // handlers in registration order and deferred-confirm is loaded
    // earlier in the baseline list.
    pi.on("agent_end", async () => {
      while (!rt.released) {
        if (!rt.releaseGate) rt.releaseGate = makeGate();
        await rt.releaseGate.promise;
      }
    });
  });
}
