// mesh-spawn.ts — long-lived peer node lifecycle manager.
//
// Supersedes the deleted mesh-authority extension (Slice 2, #161).
// Registers two tools:
//   mesh_spawn({recipe, name?, task?, workspace?, ...}) — start a long-lived
//     peer node; returns immediately with the worker's instance name.
//     The worker runs until mesh_kill or session end.
//   mesh_kill({name}) — terminate a running node gracefully (SIGTERM + SIGKILL
//     fallback); sends a `shutdown` bus envelope before killing so the worker
//     can clean up.
//
// Both tools are registered unconditionally so recipe allowlists resolve;
// execution is gated on getHabitat().spawns being non-empty.
//
// session_shutdown handler: cascade-kills all registry entries (reproduces
// cleanup logic from the deleted mesh-authority.ts).
//
// Slice 4: mesh_spawn now routes through the host launcher socket when a host
// is present (getHabitat().isHost = false on workers, mesh-mux binds the socket
// on the host). When inside the host process itself (isHost = true), the
// globalThis.__pi_mesh_mux_spawn__ hook is called directly (OQ-1).
// No-host fallback: direct spawn via runMeshSpawn + productionSpawnWorker.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getHabitat } from "../lib/habitat.js";
import {
  encodeEnvelope,
  makeShutdownEnvelope,
} from "../lib/bus-envelope.js";
import { sendOverBus } from "../lib/bus-transport.js";
import {
  runMeshSpawn,
  serializeHabitatOverlay,
  type WorkerHandle,
  type SpawnArgs,
} from "../lib/peer-spawn.js";
import { generateInstanceName } from "../lib/agent-naming.js";
import { buildRecipeChildArgv, resolvePiBin, resolveRepoRoot } from "../lib/child-spawn.mjs";
import {
  makeSpawnRequestEnvelope,
  makeKillRequestEnvelope,
} from "../lib/launcher-envelope.mjs";
// requestSpawn and sendControl imported lazily from launcher-bridge to avoid
// circular module issues; they are accessed via getBridgeAPI() below.

const REPO_ROOT = resolveRepoRoot();
const PI_BIN = resolvePiBin(REPO_ROOT);
const AGENTS_DIR = path.join(REPO_ROOT, "pi-sandbox", "agents");

/**
 * Lazily access the launcher-bridge module's exported API.
 * Returns null when the bridge is not loaded (solo run, no launcher socket).
 */
function getBridgeAPI(): { requestSpawn: typeof import("./launcher-bridge.js").requestSpawn; sendControl: typeof import("./launcher-bridge.js").sendControl } | null {
  try {
    // jiti loads .ts extensions; the bridge stash is on globalThis.
    // We dynamically import to avoid circular-import issues at module load time.
    // In practice, launcher-bridge is loaded before mesh-spawn (both in peer.yaml).
    const g = globalThis as Record<string, unknown>;
    // If the bridge state is present and ready, use it.
    const bridgeState = g.__pi_launcher_bridge__ as { ready?: boolean } | undefined;
    if (!bridgeState?.ready) return null;
    // Import the module synchronously via require — safe since it's loaded by jiti.
    const { requestSpawn, sendControl } = require("./launcher-bridge.js") as typeof import("./launcher-bridge.js");
    return { requestSpawn, sendControl };
  } catch {
    return null;
  }
}

/** Check if the globalThis host hook is installed (OQ-1: in-process host path). */
function getHostSpawnHook(): ((req: Record<string, unknown>) => Promise<{ ok: boolean; name?: string; error?: string }>) | null {
  const g = globalThis as Record<string, unknown>;
  const hook = g.__pi_mesh_mux_spawn__;
  if (typeof hook === "function") return hook as (req: Record<string, unknown>) => Promise<{ ok: boolean; name?: string; error?: string }>;
  return null;
}

interface MeshNode {
  name: string;
  recipe: string;
  scratchRoot: string;
  handle: WorkerHandle;
  startedAt: number;
}

function getRegistry(): Map<string, MeshNode> {
  const g = globalThis as { __pi_mesh_spawn_nodes__?: Map<string, MeshNode> };
  return (g.__pi_mesh_spawn_nodes__ ??= new Map());
}

/**
 * Dynamic-worker admission predicate for peer-bus.ts.
 * Returns true for any worker name that this process spawned via mesh_spawn
 * and that is still in the registry (i.e. running or recently killed).
 * Published on globalThis so peer-bus can find it without a direct import.
 * Published so peer-bus can admit dynamically-spawned workers before the
 * static acceptsWorkFrom check (via the __pi_mesh_spawn_is_my_worker__ predicate).
 */
function isMeshSpawnWorker(name: string): boolean {
  return getRegistry().has(name);
}

function registerMeshSpawnPredicate(): void {
  (globalThis as { __pi_mesh_spawn_is_my_worker__?: (name: string) => boolean })
    .__pi_mesh_spawn_is_my_worker__ = isMeshSpawnWorker;
}

/** Gracefully kill a node: SIGTERM, then SIGKILL after 2 s. */
function killNode(node: MeshNode): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) { settled = true; resolve(); }
    };
    // Race: either exited or timed out
    node.handle.exited.then(done).catch(done);
    try { node.handle.kill("SIGTERM"); } catch { /* noop */ }
    setTimeout(() => {
      if (!settled) {
        try { node.handle.kill("SIGKILL"); } catch { /* noop */ }
      }
      done();
    }, 2000);
  });
}

/** Production spawn implementation using buildRecipeChildArgv. */
function productionSpawnWorker(args: SpawnArgs): WorkerHandle {
  const topologyOverlay = serializeHabitatOverlay(args.habitatOverlay);
  const childArgs = buildRecipeChildArgv({
    piBin: PI_BIN,
    recipe: args.recipe,
    sandbox: args.scratchRoot,
    busRoot: args.busRoot,
    instanceName: args.workerName,
    topologyOverlay,
    // For long-lived workers, task is passed via --task (NOT -p) so the worker
    // starts interactively and uses the task as per-instance role context.
    task: args.task && args.task.length > 0 ? args.task : undefined,
  });
  const child = spawn(process.execPath, childArgs, {
    cwd: args.callerCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal: signal as NodeJS.Signals | null });
    });
  });

  return {
    pid: child.pid ?? 0,
    exited,
    kill: (sig?: NodeJS.Signals) => { try { child.kill(sig ?? "SIGTERM"); } catch { /* noop */ } },
  };
}

export default function (pi: ExtensionAPI) {
  const registry = getRegistry();

  // Register the dynamic-worker admission predicate for peer-bus.ts.
  registerMeshSpawnPredicate();

  // ── session_shutdown: cascade-kill all spawned nodes ─────────────────────
  const cleanup = async () => {
    await Promise.all([...registry.values()].map(killNode));
    registry.clear();
  };
  pi.on("session_shutdown", async () => cleanup());
  process.once("exit", () => {
    for (const node of registry.values()) {
      try { node.handle.kill("SIGKILL"); } catch { /* noop */ }
    }
  });

  // ── mesh_spawn ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "mesh_spawn",
    label: "Mesh Spawn",
    description:
      "Start a long-lived peer worker on the mesh bus. The worker binds to the " +
      "shared peer bus under its instance name and can be reached via peer_send / " +
      "peer_call. Returns immediately; the worker runs until mesh_kill or session " +
      "end. Recipe must be in the agent's spawns: allowlist.",
    parameters: Type.Object({
      recipe: Type.String({
        description: "Recipe YAML name in pi-sandbox/agents/ (without .yaml).",
      }),
      name: Type.Optional(
        Type.String({
          description:
            "Unique instance name for this node on the bus. " +
            "Auto-generated as <breed>-<shortName> if omitted.",
        }),
      ),
      task: Type.Optional(
        Type.String({
          description:
            "Per-instance task context appended to the worker's system prompt via --task. " +
            "For long-lived workers (non-interactive); use peer_send to drive them.",
        }),
      ),
      workspace: Type.Optional(
        Type.Object({
          include: Type.Array(Type.String(), {
            description:
              "Relative paths (files or dirs) to copy from the caller sandbox " +
              "into the worker scratch root before launch.",
          }),
        }),
      ),
      groups: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Group memberships for this worker. Determines which peers it can " +
            "communicate with (ADR-0008 visibility scoping). Names starting with '_' " +
            "are reserved. Ungrouped workers join @_default implicitly.",
        }),
      ),
      escalatesTo: Type.Optional(
        Type.String({ description: "Override escalation target (Slice 3+, accepted but not yet plumbed to wiring resolver)." }),
      ),
      submitsWorkTo: Type.Optional(
        Type.String({ description: "Override submission target (Slice 3+, accepted but not yet plumbed to wiring resolver)." }),
      ),
      messagesWith: Type.Optional(
        Type.Array(Type.String(), { description: "Override peer list (Slice 3+, accepted but not yet plumbed to wiring resolver)." }),
      ),
      acceptsWorkFrom: Type.Optional(
        Type.Array(Type.String(), { description: "Override inbound peers (Slice 3+, accepted but not yet plumbed to wiring resolver)." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
      // ── 1. Read habitat ──────────────────────────────────────────────────
      let spawns: string[] = [];
      let callerName = "anonymous";
      let busRoot: string;
      let callerSandbox: string;

      try {
        const h = getHabitat();
        spawns = Array.isArray(h.spawns) ? h.spawns : [];
        callerName = h.instanceName || "anonymous";
        busRoot = h.busRoot;
        callerSandbox = h.scratchRoot;
      } catch {
        return {
          content: [{ type: "text", text: "mesh_spawn: Habitat not available." }],
          details: { error: "habitat_unavailable" },
        };
      }

      // ── 2. Recipe allowlist enforcement ─────────────────────────────────
      if (spawns.length === 0 || !spawns.includes(params.recipe)) {
        const list = spawns.length > 0 ? `[${spawns.join(", ")}]` : "[]";
        return {
          content: [
            {
              type: "text",
              text: `mesh_spawn: recipe '${params.recipe}' not in this agent's allowed list ${list}`,
            },
          ],
          details: { error: "recipe_not_allowed", recipe: params.recipe, allowed: spawns },
        };
      }

      // ── 2b. Validate groups param ───────────────────────────────────────
      if (params.groups !== undefined) {
        for (const g of params.groups) {
          if (typeof g !== "string" || !g) {
            return {
              content: [{ type: "text", text: `mesh_spawn: 'groups' must be an array of non-empty strings.` }],
              details: { error: "invalid_groups", groups: params.groups },
            };
          }
          if (g.startsWith("_")) {
            return {
              content: [{
                type: "text",
                text: `mesh_spawn: group name '${g}' is reserved — group names starting with '_' are not allowed.`,
              }],
              details: { error: "reserved_group_name", group: g },
            };
          }
        }
      }

      // ── 3. Recipe-exists check ───────────────────────────────────────────
      const recipeFile = path.join(AGENTS_DIR, `${params.recipe}.yaml`);
      if (!fs.existsSync(recipeFile)) {
        return {
          content: [
            {
              type: "text",
              text: `mesh_spawn: recipe '${params.recipe}' not found at ${recipeFile}`,
            },
          ],
          details: { error: "recipe_not_found", recipe: params.recipe },
        };
      }

      // ── 4. Generate worker name ─────────────────────────────────────────
      let workerName = params.name;
      if (!workerName) {
        const taken = new Set<string>(registry.keys());
        workerName = generateInstanceName({ shortName: params.recipe, taken });
      } else if (registry.has(workerName)) {
        return {
          content: [
            {
              type: "text",
              text: `mesh_spawn: instance '${workerName}' already running.`,
            },
          ],
          details: { error: "name_collision", name: workerName },
        };
      }

      // ── 5. Route: host-relay or direct spawn ────────────────────────────

      // OQ-1: If running inside the host process itself, call the hook directly.
      const hostHook = getHostSpawnHook();
      if (hostHook) {
        const req = makeSpawnRequestEnvelope({
          msg_id: randomUUID(),
          from: callerName,
          recipe: params.recipe,
          name: workerName,
          groups: params.groups,
          task: params.task,
          workspace: params.workspace,
          escalatesTo: params.escalatesTo,
          submitsWorkTo: params.submitsWorkTo,
          messagesWith: params.messagesWith,
          acceptsWorkFrom: params.acceptsWorkFrom,
        });
        let spawnResult: { ok: boolean; name?: string; error?: string };
        try {
          spawnResult = await hostHook(req as Record<string, unknown>);
        } catch (e) {
          return {
            content: [{ type: "text", text: `mesh_spawn (host hook) failed: ${(e as Error).message}` }],
            details: { error: "spawn_failed_hook", reason: (e as Error).message },
          };
        }
        if (!spawnResult.ok) {
          return {
            content: [{ type: "text", text: `mesh_spawn failed: ${spawnResult.error ?? "unknown error"}` }],
            details: { error: "spawn_failed", reason: spawnResult.error },
          };
        }
        const assignedName = spawnResult.name ?? workerName;
        return {
          content: [
            {
              type: "text",
              text: `Spawned worker '${assignedName}' (recipe: ${params.recipe}) via host. ` +
                `Address it via peer_send({to: "${assignedName}", ...}) or peer_call.`,
            },
          ],
          details: { name: assignedName, recipe: params.recipe },
        };
      }

      // Launcher-bridge path: round-trip through host launcher socket.
      const bridge = getBridgeAPI();
      if (bridge) {
        const req = makeSpawnRequestEnvelope({
          msg_id: randomUUID(),
          from: callerName,
          recipe: params.recipe,
          name: workerName,
          groups: params.groups,
          task: params.task,
          workspace: params.workspace,
          escalatesTo: params.escalatesTo,
          submitsWorkTo: params.submitsWorkTo,
          messagesWith: params.messagesWith,
          acceptsWorkFrom: params.acceptsWorkFrom,
        });
        let spawnResult: { ok: boolean; name?: string; error?: string };
        try {
          spawnResult = await bridge.requestSpawn(req as Record<string, unknown>);
        } catch (e) {
          return {
            content: [{ type: "text", text: `mesh_spawn (launcher) failed: ${(e as Error).message}` }],
            details: { error: "spawn_failed_launcher", reason: (e as Error).message },
          };
        }
        if (!spawnResult.ok) {
          return {
            content: [{ type: "text", text: `mesh_spawn failed: ${spawnResult.error ?? "unknown error"}` }],
            details: { error: "spawn_failed", reason: spawnResult.error },
          };
        }
        const assignedName = spawnResult.name ?? workerName;
        return {
          content: [
            {
              type: "text",
              text: `Spawned worker '${assignedName}' (recipe: ${params.recipe}) via launcher. ` +
                `Address it via peer_send({to: "${assignedName}", ...}) or peer_call.`,
            },
          ],
          details: { name: assignedName, recipe: params.recipe },
        };
      }

      // fallback: no host — direct spawn
      const result = await runMeshSpawn({
        recipe: params.recipe,
        workerName,
        busRoot,
        task: params.task,
        workspace: params.workspace,
        groups: params.groups,
        callerSandbox,
        callerName,
        callerCwd: ctx.cwd,
        spawnWorker: productionSpawnWorker,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `mesh_spawn failed: ${result.error}` }],
          details: { error: "spawn_failed", reason: result.error },
        };
      }

      // ── 6. Register (fallback-direct-spawned nodes only) ─────────────────
      const node: MeshNode = {
        name: workerName,
        recipe: params.recipe,
        scratchRoot: result.scratchRoot,
        handle: result.handle,
        startedAt: Date.now(),
      };
      registry.set(workerName, node);

      // Auto-clean on exit
      result.handle.exited.then(() => {
        registry.delete(workerName!);
        try {
          fs.rmSync(result.scratchRoot, { recursive: true, force: true });
        } catch { /* noop */ }
      }).catch(() => { /* noop */ });

      return {
        content: [
          {
            type: "text",
            text: `Spawned worker '${workerName}' (recipe: ${params.recipe}). ` +
              `Address it via peer_send({to: "${workerName}", ...}) or peer_call.`,
          },
        ],
        details: { name: workerName, recipe: params.recipe, scratchRoot: result.scratchRoot },
      };
    },
  });

  // ── mesh_kill ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "mesh_kill",
    label: "Mesh Kill",
    description:
      "Terminate a long-lived mesh worker started by mesh_spawn. Sends a " +
      "shutdown envelope over the bus (so the worker can clean up), then " +
      "SIGTERM; SIGKILL after 2 s if still running. " +
      "TODO Slice 4: route through the host launcher socket instead.",
    parameters: Type.Object({
      name: Type.String({ description: "Instance name of the worker to terminate." }),
    }),
    async execute(_id, params): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
      const node = registry.get(params.name);
      if (!node) {
        return {
          content: [
            {
              type: "text",
              text: `mesh_kill: no running worker named '${params.name}'.`,
            },
          ],
          details: { killed: false, reason: "not_found", name: params.name },
        };
      }

      // Get busRoot for the shutdown envelope
      let busRoot: string | undefined;
      let callerName = "anonymous";
      try {
        const h = getHabitat();
        busRoot = h.busRoot;
        callerName = h.instanceName || "anonymous";
      } catch { /* Habitat unavailable; skip envelope */ }

      // Send a shutdown envelope so the worker can gracefully stop
      if (busRoot) {
        try {
          const env = makeShutdownEnvelope({
            from: callerName,
            to: params.name,
            reason: "terminated by mesh_kill",
          });
          await sendOverBus(busRoot, params.name, encodeEnvelope(env), 500);
        } catch { /* best-effort; proceed to kill regardless */ }
      }

      registry.delete(params.name);
      await killNode(node);

      // Clean up scratch root
      try {
        fs.rmSync(node.scratchRoot, { recursive: true, force: true });
      } catch { /* noop */ }

      return {
        content: [{ type: "text", text: `Killed worker '${params.name}'.` }],
        details: { killed: true, name: params.name },
      };
    },
  });
}
