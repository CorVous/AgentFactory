// atomic-delegate extension — single-tool delegation primitive.
//
// Registers `delegate({recipe, task, workspace?, timeout_ms?})`. Each
// call:
//   1. Validates the recipe is in this agent's allowed list.
//   2. Spawns a worker via scripts/run-agent.mjs in a fresh tmpdir, with
//      a habitat overlay locking the worker to this agent: supervisor =
//      submitTo = peers = acceptedFrom = [callerName]; agents = [].
//   3. Waits (up to timeout) for the worker's deferred-confirm to ship
//      a `submission` envelope back via the bus.
//   4. Replies to the worker with approval-result(approved=true) so the
//      worker's shipSubmission resolves and the worker exits cleanly.
//   5. Registers the artifacts as a deferred-confirm handler so they
//      preview and apply at this agent's end-of-turn alongside any of
//      its own deferred-* operations.
//   6. Returns synchronously to the model with a summary.
//
// Inbound submission routing: an `__pi_atomic_delegate_dispatch__` hook
// is published on globalThis. agent-bus.ts calls it BEFORE acceptedFrom
// enforcement so dynamically-spawned workers don't need to be in the
// caller's static acceptedFrom list.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";
import {
  encodeEnvelope,
  makeApprovalResultEnvelope,
  type Artifact,
  type Envelope,
} from "../_lib/bus-envelope";
import { generateInstanceName } from "../_lib/agent-naming";
import { getHabitat } from "../_lib/habitat";
import { applyArtifacts } from "../_lib/submission-apply";
import {
  runAtomicDelegate,
  type DispatchHookRegistry,
  type SpawnArgs,
  type WorkerHandle,
} from "../_lib/atomic-delegate";
import { registerDeferredHandler } from "./deferred-confirm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RUNNER_PATH = path.join(REPO_ROOT, "scripts", "run-agent.mjs");
const AGENTS_DIR = path.join(REPO_ROOT, "pi-sandbox", "agents");

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface PendingDelegate {
  onSubmission: (artifacts: Artifact[]) => void;
}

interface AtomicDelegateState {
  pending: Map<string, PendingDelegate>;
  callerName: string;
  busRoot: string;
}

function getState(): AtomicDelegateState {
  const g = globalThis as { __pi_atomic_delegate__?: AtomicDelegateState };
  return (g.__pi_atomic_delegate__ ??= {
    pending: new Map(),
    callerName: "",
    busRoot: "",
  });
}

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

function sendReply(busRoot: string, env: Envelope): void {
  const dest = path.join(busRoot, `${env.to}.sock`);
  const sock = net.connect(dest);
  const cleanup = () => {
    sock.removeAllListeners();
    sock.destroy();
  };
  const timer = setTimeout(cleanup, 1000);
  sock.once("connect", () => {
    sock.write(encodeEnvelope(env), "utf8", () => {
      clearTimeout(timer);
      cleanup();
    });
  });
  sock.once("error", () => {
    clearTimeout(timer);
    cleanup();
  });
}

// Called by agent-bus.ts handleIncoming for typed envelopes BEFORE the
// acceptedFrom check. Returns true when the envelope was consumed.
export function dispatchToAtomicDelegate(env: Envelope): boolean {
  const state = getState();
  const entry = state.pending.get(env.from);
  if (!entry) return false;
  if (env.payload.kind !== "submission") return false;

  // Reply approval-result(approved=true) so the worker's shipSubmission
  // resolves and pi -p exits cleanly.
  const reply = makeApprovalResultEnvelope({
    from: state.callerName,
    to: env.from,
    in_reply_to: env.msg_id,
    approved: true,
    note: "queued for end-of-turn approval",
  });
  if (state.busRoot) sendReply(state.busRoot, reply);

  entry.onSubmission(env.payload.artifacts);
  return true;
}

function registerDispatchHook(): void {
  (
    globalThis as { __pi_atomic_delegate_dispatch__?: typeof dispatchToAtomicDelegate }
  ).__pi_atomic_delegate_dispatch__ = dispatchToAtomicDelegate;
}

function describeArtifact(a: Artifact): string {
  switch (a.kind) {
    case "write":
      return `  write  ${a.relPath}  (${a.content.length} bytes)`;
    case "edit":
      return `  edit   ${a.relPath}  (${a.edits.length} change${a.edits.length === 1 ? "" : "s"})`;
    case "move":
      return `  move   ${a.src} → ${a.dst}`;
    case "delete":
      return `  delete ${a.relPath}`;
  }
}

function productionSpawnWorker(signal: AbortSignal | undefined): (args: SpawnArgs) => WorkerHandle {
  return (args: SpawnArgs): WorkerHandle => {
    const overlayJson = JSON.stringify(args.habitatOverlay);
    const childArgs = [
      RUNNER_PATH,
      args.recipe,
      "--sandbox",
      args.scratchRoot,
      "--agent-bus",
      args.busRoot,
      "-p",
      args.task,
      "--",
      "--agent-name",
      args.workerName,
      "--topology-overlay",
      overlayJson,
    ];
    const child = spawn(process.execPath, childArgs, {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, sig) => resolve({ code, signal: sig }));
    });

    const killHandler = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
    };
    signal?.addEventListener("abort", killHandler, { once: true });

    return {
      pid: child.pid ?? -1,
      exited,
      kill: (sig?: NodeJS.Signals) => {
        try {
          if (!child.killed && child.exitCode === null) child.kill(sig ?? "SIGTERM");
        } catch {
          /* noop */
        }
      },
    };
  };
}

export default function (pi: ExtensionAPI) {
  const state = getState();
  registerDispatchHook();

  pi.on("session_start", async (_event, _ctx) => {
    try {
      const h = getHabitat();
      state.callerName = h.agentName;
      state.busRoot = h.busRoot;
    } catch {
      /* fallback: leave empty; sendReply just no-ops */
    }
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Spawn a focused child agent from a recipe in pi-sandbox/agents/, hand it a task, " +
      "and wait for it to ship its drafted artifacts back. The artifacts queue alongside " +
      "any of your own deferred-* operations and apply together at end-of-turn. Single " +
      "atomic call — there is no separate approve step. The recipe must be in this " +
      "agent's allowed list (set via the recipe's `agents:` field). Multiple delegate " +
      "calls in one turn each register a separate handler and surface as separate " +
      "sections in the unified end-of-turn preview.",
    parameters: Type.Object({
      recipe: Type.String({
        description: "Name of a recipe in pi-sandbox/agents/ (without .yaml suffix).",
      }),
      task: Type.String({
        description: "The task prompt handed to the worker as its first user message.",
      }),
      workspace: Type.Optional(
        Type.Object({
          include: Type.Array(Type.String(), {
            description:
              "Relative paths under your sandbox to copy into the worker's tmpdir before launch. " +
              "Use to give the worker read-only context (e.g. existing files it needs to reference).",
          }),
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description: `Max worker runtime in ms before kill. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      let allowed: string[] = [];
      let callerName = "";
      let busRoot = "";
      let callerSandbox = path.resolve(ctx?.cwd || process.cwd());
      try {
        const h = getHabitat();
        allowed = h.agents;
        callerName = h.agentName;
        busRoot = h.busRoot;
        callerSandbox = path.resolve(h.scratchRoot);
      } catch {
        /* habitat not yet ready */
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

      if (!fs.existsSync(path.join(AGENTS_DIR, `${params.recipe}.yaml`))) {
        return {
          content: [{ type: "text", text: `delegate: recipe not found: ${params.recipe}` }],
          details: { error: "recipe_not_found", recipe: params.recipe },
        };
      }

      const meta = readChildRecipeMeta(params.recipe);
      const shortName = meta.shortName ?? params.recipe;
      const taken = new Set(state.pending.keys());

      const dispatchHookRegistry: DispatchHookRegistry = {
        register(workerName, cb) {
          state.pending.set(workerName, { onSubmission: cb });
        },
        unregister(workerName) {
          state.pending.delete(workerName);
        },
      };

      const result = await runAtomicDelegate({
        recipe: params.recipe,
        task: params.task,
        callerName,
        callerSandbox,
        busRoot,
        ...(params.workspace ? { workspace: params.workspace } : {}),
        timeoutMs: params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        spawnWorker: productionSpawnWorker(signal),
        dispatchHookRegistry,
        nameGenerator: () => generateInstanceName({ tier: meta.tier, shortName, taken }),
      });

      // Best-effort cleanup of the worker's tmpdir.
      try {
        fs.rmSync(result.scratchRoot, { recursive: true, force: true });
      } catch {
        /* noop */
      }

      if (!result.ok) {
        return {
          content: [
            { type: "text", text: `delegate(${params.recipe}) failed: ${result.error}` },
          ],
          details: {
            ok: false,
            recipe: params.recipe,
            worker: result.workerName,
            error: result.error,
          },
        };
      }

      const artifacts = result.artifacts;
      const workerName = result.workerName;
      const summary = `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} from ${workerName}`;
      const previewBody =
        artifacts.length === 0
          ? "(no artifacts)"
          : artifacts.map(describeArtifact).join("\n");

      registerDeferredHandler({
        label: `Delegate (${workerName})`,
        extension: "atomic-delegate",
        priority: 50,
        prepare: async (_handlerCtx: ExtensionContext) => ({
          status: "ok",
          summary,
          preview: previewBody,
          artifacts,
          apply: async () => {
            const r = await applyArtifacts(callerSandbox, artifacts);
            return { wrote: r.applied, failed: r.errors };
          },
        }),
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Worker ${workerName} drafted ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}; ` +
              `queued for end-of-turn approval.\n\n${previewBody}`,
          },
        ],
        details: {
          ok: true,
          recipe: params.recipe,
          worker: workerName,
          artifact_count: artifacts.length,
        },
      };
    },
  });
}
