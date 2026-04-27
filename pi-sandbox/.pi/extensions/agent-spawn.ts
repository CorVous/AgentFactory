// agent-spawn extension — blocking delegation to a focused child agent
// with parent-driven approval.
//
// Two tools:
//   - `delegate({recipe, task, sandbox?, timeout_ms?})` spawns
//     `node scripts/run-agent.mjs <recipe> -p <task>` as a subprocess.
//     If the child exits without queuing any deferred-* drafts, returns
//     the captured stdout (today's behavior). If the child queues drafts,
//     the child pauses on the per-call RPC socket, the parent records
//     the pending delegation in a globalThis registry, and `delegate`
//     returns the preview + delegation_id so the parent LLM can review
//     and decide.
//   - `approve_delegation({id, approved, escalate?, comment?})` resumes
//     a paused child. If escalate=true, the parent's own
//     requestHumanApproval primitive is used (which routes to
//     ctx.ui.confirm locally OR forwards up the parent's --rpc-sock if
//     the parent itself is a child).
//
// Why two tools: putting the parent LLM in the approval loop requires
// returning the preview to the LLM mid-delegation. A single blocking
// `delegate` can't do that.
//
// Why subprocess and not in-process createAgentSession: the parent's
// extension surface (including agent-bus's socket binding) would re-fire
// session_start for the child, causing name collisions and shared
// globalThis state. Subprocess gives clean isolation at the cost of
// startup latency.
//
// Companion to agent-bus (async peer messaging). Delegation is
// ephemeral, anonymous, and structured-return; it does NOT use the bus.
// A recipe that wants both delegation and peer messaging loads both
// extensions independently — though typically `agents:` in the recipe
// implicitly wires agent-spawn for you.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { requestHumanApproval, type ApprovalRequest } from "./deferred-confirm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RUNNER_PATH = path.join(REPO_ROOT, "scripts", "run-agent.mjs");
const AGENTS_DIR = path.join(REPO_ROOT, "pi-sandbox", "agents");

const MAX_OUTPUT_BYTES = 20_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface PendingDelegation {
  id: string;
  recipe: string;
  child: ChildProcess;
  conn: net.Socket;
  request: ApprovalRequest;
  startedAt: number;
  timeoutMs: number;
  /** Captured stdout so far (drained continuously even while paused). */
  stdoutSoFar: { value: string; truncated: boolean };
  /** Captured stderr so far. */
  stderrSoFar: { value: string };
  /** Resolved when the child has exited, with the final exit info. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Watchdog timer; cleared when approve_delegation runs. */
  timer: NodeJS.Timeout;
  /** RPC server (per-call); closed after the child exits. */
  server: net.Server;
  /** Socket path; unlinked after close. */
  sockPath: string;
}

interface SpawnState {
  pending: Map<string, PendingDelegation>;
  cleanupRegistered: boolean;
}

/** Stash the registry on globalThis so jiti's per-extension module isolation
 *  doesn't lose entries across imports. Same idiom as agent-bus / deferred-confirm. */
function getState(): SpawnState {
  const g = globalThis as { __pi_delegate_pending__?: SpawnState };
  return (g.__pi_delegate_pending__ ??= { pending: new Map(), cleanupRegistered: false });
}

function parseFlagList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function appendBuffer(buf: { value: string; truncated?: boolean }, chunk: Buffer, max: number): void {
  const s = chunk.toString("utf8");
  if (buf.value.length + s.length > max) {
    buf.value += s.slice(0, max - buf.value.length);
    if ("truncated" in buf) (buf as { truncated: boolean }).truncated = true;
  } else {
    buf.value += s;
  }
}

function unlinkSafe(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* noop */
  }
}

function killSafe(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.killed && child.exitCode === null) {
    try {
      child.kill(signal);
    } catch {
      /* noop */
    }
  }
}

function ensureProcessCleanup(state: SpawnState): void {
  if (state.cleanupRegistered) return;
  state.cleanupRegistered = true;
  process.once("exit", () => {
    for (const p of state.pending.values()) {
      try {
        p.conn.write(JSON.stringify({ type: "approval-result", approved: false }) + "\n");
        p.conn.destroy();
      } catch {
        /* noop */
      }
      killSafe(p.child);
      try {
        p.server.close();
      } catch {
        /* noop */
      }
      unlinkSafe(p.sockPath);
    }
    state.pending.clear();
  });
}

function formatPreview(p: PendingDelegation, header: string): string {
  return `${header}\n\nrecipe: ${p.recipe}\ndelegation_id: ${p.id}\n\n${p.request.preview}`;
}

function finalText(p: PendingDelegation, exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  const tail = p.stdoutSoFar.truncated ? "\n…(output truncated)" : "";
  const body = p.stdoutSoFar.value.length > 0 ? `${p.stdoutSoFar.value}${tail}` : p.stderrSoFar.value || "(no output)";
  const exitTag =
    exit.code === 0
      ? ""
      : `\n[delegate] child exited code=${exit.code} signal=${exit.signal ?? "none"}`;
  return body + exitTag;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("allowed-agents", {
    description:
      "Comma-separated list of recipe names this agent may delegate to. " +
      "Set by the runner from the recipe's `agents:` field.",
    type: "string",
  });

  const state = getState();
  ensureProcessCleanup(state);

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Spawn a child agent from a recipe in pi-sandbox/agents/, hand it a " +
      "task, and run it. If the child exits without queuing any deferred " +
      "drafts, returns the captured stdout. If the child queues drafts, " +
      "the child pauses; this tool returns the preview and a " +
      "`delegation_id`. Call `approve_delegation` to resume the child " +
      "with your approval decision (or escalate to the human). Recipe " +
      "must be in this agent's allowed list (set via the recipe's " +
      "`agents:` field).",
    parameters: Type.Object({
      recipe: Type.String({
        description: "Name of a recipe in pi-sandbox/agents/ (without .yaml suffix).",
      }),
      task: Type.String({
        description: "The task prompt handed to the child as its first user message.",
      }),
      sandbox: Type.Optional(
        Type.String({
          description:
            "Optional sandbox root for the child. Defaults to the parent's sandbox root. " +
            "Must be equal to OR a subdirectory of the parent's sandbox.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description: `Max child runtime in ms (including time spent waiting for approve_delegation). Defaults to ${DEFAULT_TIMEOUT_MS}.`,
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const allowed = parseFlagList(pi.getFlag("allowed-agents") as string | undefined);
      if (allowed.length === 0 || !allowed.includes(params.recipe)) {
        return {
          content: [
            {
              type: "text",
              text: `delegate: recipe '${params.recipe}' not in this agent's allowed list [${allowed.join(", ")}]`,
            },
          ],
          details: { error: "recipe_not_allowed", recipe: params.recipe, allowed },
        };
      }

      // Sandbox containment: child sandbox must be == or inside parent's.
      // Parent root is ctx.cwd because the runner spawns pi with cwd=sandboxRoot.
      const parentRoot = path.resolve(ctx?.cwd || process.cwd());
      const requested = path.resolve(parentRoot, params.sandbox || parentRoot);
      if (requested !== parentRoot && !requested.startsWith(parentRoot + path.sep)) {
        return {
          content: [
            {
              type: "text",
              text: `delegate: sandbox '${requested}' escapes parent root '${parentRoot}'`,
            },
          ],
          details: { error: "sandbox_escape", requested, parentRoot },
        };
      }

      const recipeFile = path.join(AGENTS_DIR, `${params.recipe}.yaml`);
      if (!existsSync(recipeFile)) {
        return {
          content: [{ type: "text", text: `delegate: recipe not found: ${recipeFile}` }],
          details: { error: "recipe_not_found", recipe: params.recipe },
        };
      }
      if (!existsSync(RUNNER_PATH)) {
        return {
          content: [{ type: "text", text: `delegate: runner missing: ${RUNNER_PATH}` }],
          details: { error: "runner_missing" },
        };
      }

      const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : DEFAULT_TIMEOUT_MS;

      // Per-call RPC socket. Lives in os.tmpdir() so it's never inside any
      // sandbox root, can't be seen by sandbox path-rejection, and is
      // unique per call.
      const sockPath = path.join(os.tmpdir(), `pi-rpc-${process.pid}-${randomUUID()}.sock`);
      const id = randomUUID();
      const stdoutBuf = { value: "", truncated: false };
      const stderrBuf = { value: "" };

      // The child opens at most one connection and sends at most one
      // request-approval line per delegation. connectionReady resolves
      // with that conn + request once the line is received.
      let resolveConnection!: (value: { conn: net.Socket; req: ApprovalRequest }) => void;
      const connectionReady = new Promise<{ conn: net.Socket; req: ApprovalRequest }>((resolve) => {
        resolveConnection = resolve;
      });

      const server = net.createServer((conn) => {
        let buf = "";
        conn.setEncoding("utf8");
        conn.on("data", (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line) as { type?: string; title?: string; summary?: string; preview?: string };
            if (
              msg.type === "request-approval" &&
              typeof msg.title === "string" &&
              typeof msg.summary === "string" &&
              typeof msg.preview === "string"
            ) {
              resolveConnection({
                conn,
                req: { title: msg.title, summary: msg.summary, preview: msg.preview },
              });
              return;
            }
          } catch {
            /* malformed; ignore — child will time out */
          }
        });
        conn.on("error", () => conn.destroy());
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(sockPath, () => {
          server.removeAllListeners("error");
          resolve();
        });
      });

      const args = [
        RUNNER_PATH,
        params.recipe,
        "--sandbox",
        requested,
        "-p",
        params.task,
        "--",
        "--rpc-sock",
        sockPath,
      ];

      const child = spawn(process.execPath, args, {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (c: Buffer) => appendBuffer(stdoutBuf, c, MAX_OUTPUT_BYTES));
      child.stderr?.on("data", (c: Buffer) => appendBuffer(stderrBuf, c, MAX_OUTPUT_BYTES));

      const onAbort = () => killSafe(child);
      signal?.addEventListener("abort", onAbort, { once: true });

      const exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = new Promise((resolve) => {
        child.once("exit", (code, sig) => resolve({ code, signal: sig }));
      });

      // Race child-exits-without-RPC against child-requests-approval.
      const sentinel = await Promise.race([
        exited.then((exit) => ({ kind: "exit" as const, exit })),
        connectionReady.then((ready) => ({ kind: "rpc" as const, ready })),
      ]);

      if (sentinel.kind === "exit") {
        // Child completed with no drafts queued. Today's behavior.
        signal?.removeEventListener("abort", onAbort);
        try {
          server.close();
        } catch {
          /* noop */
        }
        unlinkSafe(sockPath);
        const tail = stdoutBuf.truncated ? "\n…(output truncated)" : "";
        const text = stdoutBuf.value.length > 0 ? `${stdoutBuf.value}${tail}` : stderrBuf.value || "(no output)";
        return {
          content: [{ type: "text", text }],
          details: {
            recipe: params.recipe,
            paused: false,
            exit_code: sentinel.exit.code,
            exit_signal: sentinel.exit.signal,
            stdout_bytes: stdoutBuf.value.length,
            stderr_bytes: stderrBuf.value.length,
            truncated: stdoutBuf.truncated,
          },
        };
      }

      // Child requested approval. Park the delegation; return preview to LLM.
      const watchdog = setTimeout(() => {
        const e = state.pending.get(id);
        if (!e) return;
        try {
          e.conn.write(JSON.stringify({ type: "approval-result", approved: false }) + "\n");
        } catch {
          /* noop */
        }
        killSafe(e.child);
      }, timeoutMs);

      const entry: PendingDelegation = {
        id,
        recipe: params.recipe,
        child,
        conn: sentinel.ready.conn,
        request: sentinel.ready.req,
        startedAt: Date.now(),
        timeoutMs,
        stdoutSoFar: stdoutBuf,
        stderrSoFar: stderrBuf,
        exited,
        timer: watchdog,
        server,
        sockPath,
      };
      state.pending.set(id, entry);

      // Best-effort post-cleanup once the child eventually exits. The
      // registry entry stays in place until approve_delegation consumes
      // it (or the watchdog tears it down explicitly).
      exited.then(() => {
        clearTimeout(watchdog);
        signal?.removeEventListener("abort", onAbort);
        try {
          entry.conn.destroy();
        } catch {
          /* noop */
        }
        try {
          server.close();
        } catch {
          /* noop */
        }
        unlinkSafe(sockPath);
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Child paused awaiting approval. Review the preview below, then call ` +
              `approve_delegation({ id: "${id}", approved: true|false, escalate?: true, comment?: "..." }).\n\n` +
              formatPreview(entry, entry.request.title),
          },
        ],
        details: {
          recipe: params.recipe,
          paused: true,
          delegation_id: id,
          summary: entry.request.summary,
          timeout_ms: timeoutMs,
        },
      };
    },
  });

  pi.registerTool({
    name: "approve_delegation",
    label: "Approve Delegation",
    description:
      "Resume a paused delegation. Pass { id, approved: true } to apply the " +
      "child's drafts; { approved: false } to discard them. Pass " +
      "{ escalate: true } to ask the human user instead — this routes through " +
      "the same recursive primitive deferred-confirm uses, so it works whether " +
      "this agent has a UI or is itself running as a child via --rpc-sock " +
      "(escalation walks up the chain to whoever can answer).",
    parameters: Type.Object({
      id: Type.String({ description: "delegation_id from a previous `delegate` call." }),
      approved: Type.Optional(
        Type.Boolean({
          description: "Your decision. Required unless escalate=true.",
        }),
      ),
      escalate: Type.Optional(
        Type.Boolean({
          description:
            "If true, ask the human (or recursively forward up the parent chain) " +
            "instead of using `approved`.",
        }),
      ),
      comment: Type.Optional(
        Type.String({ description: "Free-text rationale (recorded in tool details, not shown to the human dialog)." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const entry = state.pending.get(params.id);
      if (!entry) {
        return {
          content: [
            {
              type: "text",
              text: `approve_delegation: no pending delegation with id '${params.id}'.`,
            },
          ],
          details: { error: "unknown_delegation", id: params.id },
        };
      }

      let approved: boolean;
      let source: "agent" | "human";
      if (params.escalate) {
        approved = await requestHumanApproval(ctx as ExtensionContext, pi, entry.request);
        source = "human";
      } else if (typeof params.approved === "boolean") {
        approved = params.approved;
        source = "agent";
      } else {
        return {
          content: [
            {
              type: "text",
              text: "approve_delegation: must pass either `approved: true|false` or `escalate: true`.",
            },
          ],
          details: { error: "missing_decision", id: params.id },
        };
      }

      // Send the decision and stop the watchdog.
      clearTimeout(entry.timer);
      try {
        entry.conn.write(JSON.stringify({ type: "approval-result", approved }) + "\n");
      } catch {
        /* the child may have died already */
      }

      // Wait for child to actually finish applying (or rejecting) and exit,
      // capped by remaining timeout budget.
      const remaining = Math.max(1000, entry.timeoutMs - (Date.now() - entry.startedAt));
      const exit = await Promise.race([
        entry.exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          setTimeout(() => {
            killSafe(entry.child);
            resolve({ code: null, signal: "SIGTERM" });
          }, remaining);
        }),
      ]);

      // Drain registry; final cleanup of socket/server already happens in
      // the exit handler attached at delegate time.
      state.pending.delete(params.id);

      const text = finalText(entry, exit);
      return {
        content: [{ type: "text", text }],
        details: {
          delegation_id: params.id,
          recipe: entry.recipe,
          approved,
          source,
          comment: params.comment ?? null,
          exit_code: exit.code,
          exit_signal: exit.signal,
          stdout_bytes: entry.stdoutSoFar.value.length,
          stderr_bytes: entry.stderrSoFar.value.length,
          truncated: entry.stdoutSoFar.truncated,
        },
      };
    },
  });
}

