// agent-spawn extension — non-blocking delegation to a focused child agent
// with parent-driven approval.
//
// Two tools:
//   - `delegate({recipe, task, sandbox?, timeout_ms?})` spawns
//     `node scripts/run-agent.mjs <recipe> -p <task>` as a subprocess and
//     returns immediately with a `delegation_id`. The child runs in the
//     background. Call `approve_delegation` when ready to collect the result.
//     Multiple `delegate` calls in sequence start multiple children in parallel.
//   - `approve_delegation({id, approved?, escalate?, comment?})` is the join
//     point. Blocks until the child settles (exits or pauses with drafts).
//     - If child exited without queuing drafts: returns captured stdout.
//     - If child paused with drafts queued and no decision given: returns the
//       preview so the parent LLM can review before deciding. Call again with
//       approved=true/false to send the decision.
//     - If child paused and approved/escalate is given: sends the decision,
//       waits for the child to finish applying/discarding, and returns captured
//       stdout. The preview is included in the result for audit.
//     - escalate=true asks the human (or forwards up --rpc-sock chain) instead
//       of using the approved parameter.
//
// Why non-blocking delegate: the parent LLM can kick off N children in
// sequence without waiting for each to settle, so all N run in parallel.
// approve_delegation is the join point that waits and collects.
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
//
// RPC protocol (newline-delimited JSON, multi-message on a single conn):
//   client → server : {type: "hello", id: <delegation_id>}
//                     // Optional. Tags the conn so subsequent status
//                     // envelopes can omit `delegation_id`.
//   client → server : {type: "request-approval", title, summary, preview}
//                     // End-of-turn approval forwarding (pre-existing).
//   server → client : {type: "approval-result", approved: boolean}
//   client → server : {type: "status", delegation_id?, agent_name,
//                      model_id, context_pct, context_tokens,
//                      context_window, cost_usd, turn_count, state}
//                     // Pushed by the child's agent-status-reporter on
//                     // turn / tool / response boundaries; cached on
//                     // the entry's `lastStatus` for the
//                     // delegation-boxes widget.

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
import { parse as parseYaml } from "yaml";
import { generateInstanceName } from "./_lib/agent-naming";
import { requestHumanApproval, type ApprovalRequest } from "./deferred-confirm";
import { getHabitat } from "./_lib/habitat";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RUNNER_PATH = path.join(REPO_ROOT, "scripts", "run-agent.mjs");
const AGENTS_DIR = path.join(REPO_ROOT, "pi-sandbox", "agents");

const MAX_OUTPUT_BYTES = 20_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Discriminated union resolved by the settlement Promise. */
type SpawnOutcome =
  | { kind: "exit"; exit: { code: number | null; signal: NodeJS.Signals | null } }
  | { kind: "rpc"; conn: net.Socket; req: ApprovalRequest };

/** Latest status snapshot pushed by the child's agent-status-reporter
 *  over the RPC socket. Read by the delegation-boxes widget to render
 *  per-delegation context-fill / cost / state above the input editor. */
interface DelegationStatus {
  receivedAt: number;
  agentName: string;
  modelId: string;
  contextPct: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
  turnCount: number;
  state: "running" | "paused" | "settled";
}

interface PendingDelegation {
  id: string;
  recipe: string;
  /** Pre-generated `<breed>-<shortName>` slug. Mirrored on the
   *  delegation-boxes PendingEntry so the box title shows the unique
   *  name from delegate-time, before any status envelope arrives. */
  agentName: string;
  child: ChildProcess;
  startedAt: number;
  timeoutMs: number;
  /** Captured stdout so far (drained continuously even while paused). */
  stdoutSoFar: { value: string; truncated: boolean };
  /** Captured stderr so far. */
  stderrSoFar: { value: string };
  /** Resolved when the child has exited, with the final exit info. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Watchdog timer; cleared when approve_delegation sends a decision. */
  timer: NodeJS.Timeout;
  /** RPC server (per-call); closed after the child exits. */
  server: net.Server;
  /** Socket path; unlinked after close. */
  sockPath: string;
  /**
   * Resolves when the child either exits cleanly (no drafts) or sends a
   * request-approval over the RPC socket (drafts queued, child paused).
   */
  settled: Promise<SpawnOutcome>;
  /**
   * Set synchronously once settled resolves as "rpc". Lets the synchronous
   * process-exit cleanup walker and watchdog send the denial without awaiting
   * the settled promise inside a sync callback.
   */
  resolvedConn?: net.Socket;
  /** Latest snapshot from the child's status reporter, if any. */
  lastStatus?: DelegationStatus;
}

function notifyWidget(): void {
  try {
    (globalThis as { __pi_delegate_invalidate__?: () => void }).__pi_delegate_invalidate__?.();
  } catch {
    /* noop */
  }
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

/** Read the child recipe's `shortName:` and `model:` so the parent can
 *  pre-generate a unique `<breed>-<shortName>` slug for the child.
 *  Tier (`LEAD_HARE_MODEL` etc.) drives the rabbit-vs-hare branch in
 *  `generateInstanceName`. Best-effort: malformed YAML falls back to
 *  the recipe filename and rabbit pool. */
function readChildRecipeMeta(recipeName: string): { shortName?: string; tier?: string } {
  try {
    const file = path.join(AGENTS_DIR, `${recipeName}.yaml`);
    const recipe = parseYaml(fs.readFileSync(file, "utf8")) as {
      shortName?: unknown;
      model?: unknown;
    };
    return {
      shortName: typeof recipe.shortName === "string" ? recipe.shortName : undefined,
      tier: typeof recipe.model === "string" ? recipe.model : undefined,
    };
  } catch {
    return {};
  }
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
      if (p.resolvedConn) {
        try {
          p.resolvedConn.write(JSON.stringify({ type: "approval-result", approved: false }) + "\n");
          p.resolvedConn.destroy();
        } catch {
          /* noop */
        }
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

function formatPreview(entry: PendingDelegation, req: ApprovalRequest): string {
  return `${req.title}\n\nrecipe: ${entry.recipe}\ndelegation_id: ${entry.id}\n\n${req.preview}`;
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
  const state = getState();
  ensureProcessCleanup(state);

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Spawn a child agent from a recipe in pi-sandbox/agents/ and hand it a task. " +
      "Returns immediately with a `delegation_id`; the child runs in the background. " +
      "Call `approve_delegation` (with the id) when you're ready to collect the result " +
      "or send your approval decision. You may call `delegate` multiple times in " +
      "sequence before calling `approve_delegation` — all children spawn in parallel. " +
      "Recipe must be in this agent's allowed list (set via the recipe's `agents:` field).",
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
      let allowed: string[] = [];
      try {
        allowed = getHabitat().agents;
      } catch {
        // Habitat not yet set; no allowed list — all recipes denied.
      }
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
          // The status reporter holds a long-lived conn and may emit many
          // newline-delimited envelopes; drain every complete line.
          while (true) {
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            try {
              const msg = JSON.parse(line) as {
                type?: string;
                title?: string;
                summary?: string;
                preview?: string;
                id?: string;
                delegation_id?: string;
                agent_name?: string;
                model_id?: string;
                context_pct?: number;
                context_tokens?: number;
                context_window?: number;
                cost_usd?: number;
                turn_count?: number;
                state?: string;
              };
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
                continue;
              }
              if (msg.type === "hello" && typeof msg.id === "string") {
                // Tag the conn so we don't have to re-parse delegation_id on
                // every status envelope. Status messages may omit it once
                // the conn is tagged.
                (conn as unknown as { __delegationId?: string }).__delegationId = msg.id;
                continue;
              }
              if (msg.type === "status") {
                const targetId =
                  (typeof msg.delegation_id === "string" && msg.delegation_id) ||
                  (conn as unknown as { __delegationId?: string }).__delegationId ||
                  "";
                if (!targetId) continue;
                const targetEntry = state.pending.get(targetId);
                if (!targetEntry) continue;
                const newState =
                  msg.state === "paused" || msg.state === "settled" || msg.state === "running"
                    ? msg.state
                    : "running";
                targetEntry.lastStatus = {
                  receivedAt: Date.now(),
                  agentName: typeof msg.agent_name === "string" ? msg.agent_name : "",
                  modelId: typeof msg.model_id === "string" ? msg.model_id : "",
                  contextPct: typeof msg.context_pct === "number" ? msg.context_pct : 0,
                  contextTokens: typeof msg.context_tokens === "number" ? msg.context_tokens : 0,
                  contextWindow: typeof msg.context_window === "number" ? msg.context_window : 0,
                  costUsd: typeof msg.cost_usd === "number" ? msg.cost_usd : 0,
                  turnCount: typeof msg.turn_count === "number" ? msg.turn_count : 0,
                  state: newState,
                };
                notifyWidget();
                continue;
              }
            } catch {
              /* malformed; ignore — child will time out */
            }
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

      // Pre-generate the child's instance name so we know it before the
      // child has booted and sent its first status envelope. The runner
      // already treats `--agent-name` in passthrough as a manual override
      // (see scripts/run-agent.mjs around the agentName branch), so the
      // value we pass here wins over the runner's own generation path.
      const meta = readChildRecipeMeta(params.recipe);
      const childShort = meta.shortName ?? params.recipe;
      const taken = new Set<string>();
      for (const e of state.pending.values()) {
        if (e.agentName) taken.add(e.agentName);
        if (e.lastStatus?.agentName) taken.add(e.lastStatus.agentName);
      }
      const childName = generateInstanceName({
        tier: meta.tier,
        shortName: childShort,
        taken,
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
        "--agent-name",
        childName,
      ];

      const child = spawn(process.execPath, args, {
        cwd: REPO_ROOT,
        env: { ...process.env, PI_AGENT_DELEGATION_ID: id },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (c: Buffer) => appendBuffer(stdoutBuf, c, MAX_OUTPUT_BYTES));
      child.stderr?.on("data", (c: Buffer) => appendBuffer(stderrBuf, c, MAX_OUTPUT_BYTES));

      const onAbort = () => killSafe(child);
      signal?.addEventListener("abort", onAbort, { once: true });

      const exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = new Promise((resolve) => {
        child.once("exit", (code, sig) => resolve({ code, signal: sig }));
      });

      // Build the settlement promise but do NOT await it here — delegate
      // returns immediately so the parent LLM can start more children.
      const settled: Promise<SpawnOutcome> = Promise.race([
        exited.then((exit) => ({ kind: "exit" as const, exit })),
        connectionReady.then((ready) => ({ kind: "rpc" as const, conn: ready.conn, req: ready.req })),
      ]);

      // Watchdog: if approve_delegation is never called within timeoutMs,
      // deny the pending request (if any) and kill the child.
      const watchdog = setTimeout(() => {
        const e = state.pending.get(id);
        if (!e) return;
        if (e.resolvedConn) {
          try {
            e.resolvedConn.write(JSON.stringify({ type: "approval-result", approved: false }) + "\n");
          } catch {
            /* noop */
          }
        }
        killSafe(e.child);
        state.pending.delete(id);
        notifyWidget();
      }, timeoutMs);

      const entry: PendingDelegation = {
        id,
        recipe: params.recipe,
        agentName: childName,
        child,
        startedAt: Date.now(),
        timeoutMs,
        stdoutSoFar: stdoutBuf,
        stderrSoFar: stderrBuf,
        exited,
        timer: watchdog,
        server,
        sockPath,
        settled,
      };
      state.pending.set(id, entry);
      notifyWidget();

      // Cache the conn synchronously once the child pauses so the cleanup
      // walker and watchdog can use it from synchronous callbacks.
      settled.then((outcome) => {
        if (outcome.kind === "rpc") {
          entry.resolvedConn = outcome.conn;
          if (entry.lastStatus) entry.lastStatus.state = "paused";
          notifyWidget();
        }
      });

      // Best-effort post-cleanup once the child eventually exits.
      exited.then(() => {
        clearTimeout(watchdog);
        signal?.removeEventListener("abort", onAbort);
        if (entry.lastStatus) entry.lastStatus.state = "settled";
        notifyWidget();
        try {
          entry.resolvedConn?.destroy();
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
              `Child spawning. delegation_id: "${id}"\n` +
              `Call approve_delegation({ id: "${id}", approved: true|false }) when ready.`,
          },
        ],
        details: {
          recipe: params.recipe,
          delegation_id: id,
          timeout_ms: timeoutMs,
        },
      };
    },
  });

  pi.registerTool({
    name: "approve_delegation",
    label: "Approve Delegation",
    description:
      "Collect the result of a delegation and, if the child queued file drafts " +
      "for approval, send your decision. Blocks until the child settles.\n\n" +
      "- Child exited without queuing drafts: returns captured stdout. No decision needed.\n" +
      "- Child paused with drafts queued, no `approved`/`escalate` given: returns the " +
      "preview so you can review it. Call again with `approved: true|false` to decide.\n" +
      "- Child paused with drafts queued, `approved` given: sends the decision immediately, " +
      "waits for the child to finish, and returns captured stdout. The preview is included " +
      "in the result for audit.\n" +
      "- `escalate: true`: ask the human user instead (routes recursively up the parent " +
      "chain if this agent is itself a child via --rpc-sock).",
    parameters: Type.Object({
      id: Type.String({ description: "delegation_id from a previous `delegate` call." }),
      approved: Type.Optional(
        Type.Boolean({
          description: "Your decision. Required unless escalate=true or the child exited without drafts.",
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

      // Wait for the child to settle (may already be done if child was fast).
      const outcome = await entry.settled;

      if (outcome.kind === "exit") {
        // Child completed without queuing any drafts — no approval needed.
        clearTimeout(entry.timer);
        state.pending.delete(params.id);
        notifyWidget();
        const text = finalText(entry, outcome.exit);
        return {
          content: [{ type: "text", text }],
          details: {
            delegation_id: params.id,
            recipe: entry.recipe,
            paused: false,
            exit_code: outcome.exit.code,
            exit_signal: outcome.exit.signal,
            stdout_bytes: entry.stdoutSoFar.value.length,
            stderr_bytes: entry.stderrSoFar.value.length,
            truncated: entry.stdoutSoFar.truncated,
          },
        };
      }

      // Child paused with drafts queued. outcome.conn is the open RPC connection.
      // Phase 1: if no decision given yet, return the preview for review.
      if (!params.escalate && typeof params.approved !== "boolean") {
        return {
          content: [
            {
              type: "text",
              text:
                `Child paused awaiting your decision. Review the preview below, ` +
                `then call approve_delegation({ id: "${params.id}", approved: true|false, escalate?: true }).\n\n` +
                formatPreview(entry, outcome.req),
            },
          ],
          details: {
            recipe: entry.recipe,
            paused: true,
            delegation_id: params.id,
            summary: outcome.req.summary,
          },
        };
      }

      // Phase 2: decision provided (or escalated). Send it.
      let approved: boolean;
      let source: "agent" | "human";
      if (params.escalate) {
        approved = await requestHumanApproval(ctx as ExtensionContext, pi, outcome.req);
        source = "human";
      } else {
        approved = params.approved as boolean;
        source = "agent";
      }

      // Stop the watchdog and send the decision.
      clearTimeout(entry.timer);
      try {
        outcome.conn.write(JSON.stringify({ type: "approval-result", approved }) + "\n");
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

      // Drain registry; final cleanup of socket/server happens in the exited
      // handler attached at delegate time.
      state.pending.delete(params.id);
      notifyWidget();

      // Include the preview in the result so the parent LLM has an audit trail
      // even when it passed approved=true without a prior preview-only call.
      const previewAudit = `\n\n--- applied preview ---\n${formatPreview(entry, outcome.req)}`;
      const text = finalText(entry, exit) + (approved ? previewAudit : "");
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
