// mesh-mux.ts — host-side mesh multiplexer (Slice 4, ADR-0009).
//
// Self-gates on getHabitat().isHost — when false (worker sessions) this
// extension is a silent no-op.  When true (host session, launched with
// --is-host) it:
//   1. Binds ${busRoot}/__launcher__.sock via LauncherSocket.
//   2. Creates PtyPool / Multiplexer / FocusController / DecisionsQueue /
//      BusTailBuffer — same as scripts/launch-mesh.mjs.
//   3. Processes the recipe's initial_mesh: block (pre-spawns peers).
//   4. Handles spawn-request / kill-request envelopes from worker peers.
//   5. Broadcasts mesh-update data-bus envelopes to visible peers on changes.
//   6. Cascade-kills all spawned peers on session_shutdown.
//
// The mesh state and the direct spawn hook are stashed on globalThis so
// mesh-spawn.ts can call the hook directly when running inside the same
// host process (OQ-1 path).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getHabitat } from "../lib/habitat.js";
import {
  makeShutdownEnvelope,
  makeMeshUpdateEnvelope,
  encodeEnvelope as encodeBusEnvelope,
} from "../lib/bus-envelope.js";
import { sendOverBus } from "../lib/bus-transport.js";
import {
  addMember,
  type CohortRegistry,
  type CohortMember,
} from "../lib/cohort-registry.js";
import { canSee, type PeerNode } from "../lib/visibility.js";
import { validateInitialMesh } from "../lib/initial-mesh-validator.js";
import {
  computeWorkerHabitatOverlay,
  serializeHabitatOverlay,
} from "../lib/peer-spawn.js";
// @ts-ignore — no TS declarations for .mjs; same pattern as mesh-spawn.ts
import { buildRecipeChildArgv, resolvePiBin, resolveRepoRoot } from "../lib/child-spawn.mjs";
import { generateInstanceName } from "../lib/agent-naming.js";

// ---------------------------------------------------------------------------
// createRequire — load .mjs engine-lib modules from TS
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve a path inside the engine/agent/lib/ directory. */
function libPath(name: string): string {
  return path.resolve(__dirname, "../lib", name);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpawnedPeer {
  name: string;
  recipe: string;
  spawnerName: string;
  groups: string[];
  scratchRoot: string;
}

interface MeshMuxState {
  launcherSock: any;
  pool: any;
  mux: any | null;
  focusController: any;
  decisionsQueue: any;
  busTailBuffer: any;
  cohortRegistry: CohortRegistry;
  /** All spawned peers (excluding the host itself). */
  peers: Map<string, SpawnedPeer>;
  /** Pending spawn-result resolvers keyed by spawner-clientId:msg_id. */
  pendingSpawns: Map<string, (result: { ok: boolean; name?: string; error?: string }) => void>;
}

function getMuxState(): MeshMuxState | undefined {
  const g = globalThis as { __pi_mesh_mux__?: MeshMuxState };
  return g.__pi_mesh_mux__;
}

function setMuxState(state: MeshMuxState): void {
  const g = globalThis as { __pi_mesh_mux__?: MeshMuxState };
  g.__pi_mesh_mux__ = state;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const REPO_ROOT = resolveRepoRoot();
const PI_BIN = resolvePiBin(REPO_ROOT);
const AGENTS_DIR = path.join(REPO_ROOT, "pi-sandbox", "agents");

/** Broadcast a data-bus mesh-update envelope to all visible peers. */
async function broadcastMeshUpdate(
  state: MeshMuxState,
  spawnerName: string,
  changes: Array<{ peer: string; recipe: string; groups: string[]; op: "add" | "remove" }>,
  hostName: string,
  busRoot: string,
): Promise<void> {
  // Build the full PeerNode list for visibility checks.
  const allNodes: PeerNode[] = [
    // The host itself
    { name: hostName, spawner: undefined, groups: [] },
    // Spawned peers
    ...[...state.peers.values()].map((p) => ({
      name: p.name,
      spawner: p.spawnerName,
      groups: p.groups,
    })),
  ];

  const hostNode: PeerNode = { name: hostName, spawner: undefined, groups: [] };

  for (const targetPeer of allNodes) {
    if (targetPeer.name === hostName) continue; // host doesn't need a bus envelope
    // Only send to peers that can see the spawner or can see at least one changed peer.
    const targetNode: PeerNode = targetPeer;
    const relevantChanges = changes.filter((c) => {
      // The target can see the new peer if:
      //   - they share a spawner and group
      //   - or the target IS the spawner
      //   - or the target is the host (always)
      const changedNode: PeerNode = { name: c.peer, spawner: spawnerName, groups: c.groups };
      return canSee(targetNode, changedNode) || targetNode.name === spawnerName;
    });
    if (relevantChanges.length === 0) continue;

    const env = makeMeshUpdateEnvelope({
      from: hostName,
      to: targetPeer.name,
      spawner: spawnerName,
      changes: relevantChanges,
    });
    await sendOverBus(busRoot, targetPeer.name, encodeBusEnvelope(env), 500).catch(() => {
      // Peer may not be listening yet — best-effort
    });
  }

  // Also send to the host itself via bus if needed (self-message for host-side
  // cohort tracking in peer-bus; skip for now — the registry is updated in-process).
  void hostNode;
}

/** Spawn a peer via the PtyPool using buildRecipeChildArgv. */
function spawnPeerViaPtyPool(
  state: MeshMuxState,
  opts: {
    workerName: string;
    recipe: string;
    spawnerName: string;
    groups: string[];
    task?: string;
    workspace?: { include: string[] };
    busRoot: string;
    debug: boolean;
  },
): string {
  const { workerName, recipe, spawnerName, groups, task, busRoot, debug } = opts;

  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-mesh-${workerName}-`),
  );

  // Build habitat overlay
  const habitatOverlay = computeWorkerHabitatOverlay(spawnerName);
  if (groups && groups.length > 0) {
    habitatOverlay.groups = groups;
  }
  habitatOverlay.spawns = []; // workers have no child spawn capability by default

  const topologyOverlay = serializeHabitatOverlay(habitatOverlay);

  const argv = buildRecipeChildArgv({
    piBin: PI_BIN,
    recipe,
    sandbox: scratchRoot,
    busRoot,
    instanceName: workerName,
    topologyOverlay,
    task,
    inheritPty: true, // children run inside host's PTY pool
    debug,
  });

  const cols = process.stdout.isTTY ? (process.stdout.columns || 220) : 220;
  const rows = process.stdout.isTTY ? (process.stdout.rows || 50) : 50;

  // Spawn via PtyPool
  state.pool.spawn({
    name: workerName,
    cmd: process.execPath,
    args: argv.slice(1), // first element is the pi bin (the "cmd")
    cols,
    rows,
    cwd: REPO_ROOT,
    env: process.env as Record<string, string>,
  });

  return scratchRoot;
}

// ---------------------------------------------------------------------------
// handleSpawnRequest — called for spawn-request envelopes from worker peers
// ---------------------------------------------------------------------------

async function handleSpawnRequest(
  state: MeshMuxState,
  env: Record<string, unknown>,
  hostName: string,
  busRoot: string,
  debug: boolean,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  const {
    makeSpawnResultEnvelope,
  } = _require(libPath("launcher-envelope.mjs")) as { makeSpawnResultEnvelope: (args: Record<string, unknown>) => Record<string, unknown> };

  const spawnerName = env.from as string;
  const recipe = env.recipe as string;
  const requestedName = env.name as string | undefined;
  const groups: string[] = Array.isArray(env.groups) ? env.groups as string[] : [];
  const task = typeof env.task === "string" ? env.task : undefined;
  const workspace = typeof env.workspace === "object" && env.workspace !== null
    ? env.workspace as { include: string[] }
    : undefined;

  // Validate groups — no _ prefix
  for (const g of groups) {
    if (typeof g === "string" && g.startsWith("_")) {
      return { ok: false, error: `group name '${g}' is reserved` };
    }
  }

  // Validate recipe is in spawns: allowlist for the spawner
  // For now: any recipe file that exists is allowed (full allowlist check is
  // done in mesh_spawn itself before sending spawn-request). The host
  // re-validates that the recipe file exists.
  if (!recipe || typeof recipe !== "string") {
    return { ok: false, error: "spawn-request: missing recipe" };
  }

  const recipeFile = path.join(AGENTS_DIR, `${recipe}.yaml`);
  if (!fs.existsSync(recipeFile)) {
    return { ok: false, error: `recipe '${recipe}' not found` };
  }

  // Allocate worker name
  let workerName = requestedName;
  if (!workerName) {
    const taken = new Set<string>([...state.peers.keys(), hostName]);
    workerName = generateInstanceName({ shortName: recipe, taken });
  } else if (state.peers.has(workerName)) {
    return { ok: false, error: `instance '${workerName}' already running` };
  }

  // Spawn
  let scratchRoot: string;
  try {
    scratchRoot = spawnPeerViaPtyPool(state, {
      workerName,
      recipe,
      spawnerName,
      groups,
      task,
      workspace,
      busRoot,
      debug,
    });
  } catch (e) {
    return { ok: false, error: `spawn failed: ${(e as Error).message}` };
  }

  // Register in cohort and peer map
  const member: CohortMember = { peer: workerName, recipe };
  addMember(state.cohortRegistry, spawnerName, member, groups);

  state.peers.set(workerName, {
    name: workerName,
    recipe,
    spawnerName,
    groups,
    scratchRoot,
  });

  state.focusController.registerPeer(workerName);

  // Broadcast mesh-update BEFORE returning spawn-result
  await broadcastMeshUpdate(
    state,
    spawnerName,
    [{ peer: workerName, recipe, groups, op: "add" }],
    hostName,
    busRoot,
  );

  if (debug) {
    process.stderr.write(
      `mesh-mux: spawned '${workerName}' (recipe=${recipe}, spawner=${spawnerName})\n`,
    );
  }

  return { ok: true, name: workerName };
}

// ---------------------------------------------------------------------------
// processInitialMesh — spawn initial_mesh: entries at session_start
// ---------------------------------------------------------------------------

async function processInitialMesh(
  state: MeshMuxState,
  hostName: string,
  busRoot: string,
  debug: boolean,
  ctx: ExtensionContext,
): Promise<void> {
  const habitat = getHabitat();
  const entries = habitat.initialMesh;
  if (!entries || entries.length === 0) return;

  // Build spawns list from habitat
  const spawns = Array.isArray(habitat.spawns) ? habitat.spawns : [];

  // Validate
  const { errors } = validateInitialMesh(
    entries,
    spawns,
    (recipeName) => fs.existsSync(path.join(AGENTS_DIR, `${recipeName}.yaml`)),
  );
  if (errors.length > 0) {
    ctx.ui.notify(
      `mesh-mux: initial_mesh validation failed:\n${errors.map((e) => `  ${e}`).join("\n")}`,
      "error",
    );
    return;
  }

  // Pre-allocate names for all entries (so $siblings resolves correctly)
  const taken = new Set<string>([hostName]);
  const allocatedNames: string[] = [];
  for (const entry of entries) {
    if (entry.name) {
      taken.add(entry.name);
      allocatedNames.push(entry.name);
    } else {
      const name = generateInstanceName({ shortName: entry.recipe, taken });
      taken.add(name);
      allocatedNames.push(name);
    }
  }

  // Spawn each entry
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const workerName = allocatedNames[i];
    const spawnerName = hostName; // host is the spawner for initial_mesh
    const groups: string[] = Array.isArray(entry.groups) ? (entry.groups as string[]) : [];
    const task = typeof entry.task === "string" ? entry.task : undefined;

    let scratchRoot: string;
    try {
      scratchRoot = spawnPeerViaPtyPool(state, {
        workerName,
        recipe: entry.recipe,
        spawnerName,
        groups,
        task,
        busRoot,
        debug,
      });
    } catch (e) {
      ctx.ui.notify(
        `mesh-mux: failed to spawn initial_mesh[${i}] '${workerName}': ${(e as Error).message}`,
        "error",
      );
      continue;
    }

    const member: CohortMember = { peer: workerName, recipe: entry.recipe };
    addMember(state.cohortRegistry, spawnerName, member, groups);

    state.peers.set(workerName, {
      name: workerName,
      recipe: entry.recipe,
      spawnerName,
      groups,
      scratchRoot,
    });

    state.focusController.registerPeer(workerName);

    if (debug) {
      process.stderr.write(
        `mesh-mux: spawned initial_mesh peer '${workerName}' (recipe=${entry.recipe})\n`,
      );
    }
  }

  // Broadcast one mesh-update for all initial peers
  if (allocatedNames.length > 0) {
    const changes = allocatedNames
      .filter((n) => state.peers.has(n))
      .map((n) => {
        const p = state.peers.get(n)!;
        return { peer: p.name, recipe: p.recipe, groups: p.groups, op: "add" as const };
      });

    if (changes.length > 0) {
      await broadcastMeshUpdate(state, hostName, changes, hostName, busRoot);
    }
  }

  // Set initial focus to the first spawned peer
  if (allocatedNames.length > 0 && state.peers.has(allocatedNames[0])) {
    state.focusController.setFocus(allocatedNames[0]);
  }
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // SELF-GATE: only activate for host sessions.
    let habitat;
    try {
      habitat = getHabitat();
    } catch {
      return; // no Habitat (raw pi) — stay inert
    }

    if (!habitat.isHost) return;

    const busRoot = habitat.busRoot;
    const hostName = habitat.instanceName;
    const debug = habitat.debug === true;

    if (!busRoot) {
      ctx.ui.notify("mesh-mux: no busRoot in Habitat — cannot bind launcher socket", "error");
      return;
    }

    // Ensure busRoot dir exists
    try {
      fs.mkdirSync(busRoot, { recursive: true });
    } catch { /* already exists */ }

    // ── Load .mjs modules via createRequire ──────────────────────────────────

    let LauncherSocket: any;
    let createLauncherSocket: any;
    let createPtyPool: any;
    let createMultiplexer: any;
    let createDecisionsQueue: any;
    let createFocusController: any;
    let createBusTailBuffer: any;
    let makeFocusChangedEnvelope: any;
    let makeTailToggleEnvelope: any;
    let makeSpawnResultEnvelope: any;
    let makeSpawnRequestEnvelope: any;

    try {
      const sockMod = _require(libPath("launcher-socket.mjs"));
      LauncherSocket = sockMod.LauncherSocket;
      createLauncherSocket = sockMod.createLauncherSocket;

      const ptyMod = _require(libPath("pty-pool.mjs"));
      createPtyPool = ptyMod.createPtyPool;

      const muxMod = _require(libPath("multiplexer.mjs"));
      createMultiplexer = muxMod.createMultiplexer;

      const dqMod = _require(libPath("decisions-queue.mjs"));
      createDecisionsQueue = dqMod.createDecisionsQueue;

      const fcMod = _require(libPath("focus-controller.mjs"));
      createFocusController = fcMod.createFocusController;

      const btMod = _require(libPath("bus-tail.mjs"));
      createBusTailBuffer = btMod.createBusTailBuffer;

      const envMod = _require(libPath("launcher-envelope.mjs"));
      makeFocusChangedEnvelope = envMod.makeFocusChangedEnvelope;
      makeTailToggleEnvelope = envMod.makeTailToggleEnvelope;
      makeSpawnResultEnvelope = envMod.makeSpawnResultEnvelope;
      makeSpawnRequestEnvelope = envMod.makeSpawnRequestEnvelope;
    } catch (e) {
      ctx.ui.notify(`mesh-mux: failed to load engine-lib modules: ${(e as Error).message}`, "error");
      return;
    }

    // ── Bind launcher socket ─────────────────────────────────────────────────

    const launcherSock = createLauncherSocket();

    try {
      await launcherSock.bind(busRoot);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.includes("already held by a live launcher")) {
        ctx.ui.notify(`mesh-mux: ${msg}`, "error");
        return;
      }
      ctx.ui.notify(`mesh-mux: failed to bind launcher socket: ${msg}`, "error");
      return;
    }

    // ── Create subsystems ────────────────────────────────────────────────────

    const pool = createPtyPool();
    const isTTY = Boolean(ctx.hasUI);
    const mux = isTTY ? createMultiplexer({ out: process.stdout }) : null;
    const decisionsQueue = createDecisionsQueue();
    const focusController = createFocusController();
    const busTailBuffer = createBusTailBuffer();
    const cohortRegistry: CohortRegistry = new Map();

    const state: MeshMuxState = {
      launcherSock,
      pool,
      mux,
      focusController,
      decisionsQueue,
      busTailBuffer,
      cohortRegistry,
      peers: new Map(),
      pendingSpawns: new Map(),
    };

    setMuxState(state);

    // ── Wire mux ─────────────────────────────────────────────────────────────

    if (mux) {
      mux.attachPool(pool);
      mux.attachResizeHandler(pool);
    }

    // ── Wire focus controller → launcher broadcast ───────────────────────────

    focusController.setBroadcast(
      (env: any) => launcherSock.broadcast(env),
      () => decisionsQueue.count(),
    );

    // Re-emit snapshot when new client connects (catch-up for late arrivals)
    launcherSock.on("client-connected", () => {
      focusController.broadcastRailUpdate();
    });

    // Focus change → broadcast focus-changed + update mux
    focusController.on("focus-changed", ({ focused }: { focused: string | null }) => {
      const env = makeFocusChangedEnvelope({ focused });
      launcherSock.broadcast(env);
      if (mux) {
        mux.setFocus(focused);
      }
    });

    // ── Pool crash handler ───────────────────────────────────────────────────

    pool.on("error", (peer: string, err: Error) => {
      process.stderr.write(
        `mesh-mux: failed to spawn peer "${peer}": ${err?.message ?? err}\n`,
      );
    });

    pool.on("crash", (ev: { peer: string; exitCode: number | null; signal: string | null }) => {
      const { peer, exitCode, signal } = ev;
      focusController.setPeerState(peer, "crashed");
      process.stderr.write(
        `mesh-mux: peer "${peer}" crashed (code=${exitCode} signal=${signal})\n`,
      );
      focusController.handleCrash(peer, null);
      focusController.unregisterPeer(peer);
    });

    // ── Dispatch inbound envelopes from peers ─────────────────────────────────

    const busTailState = { on: false, filter: undefined as string | undefined };

    launcherSock.on("envelope", async (env: Record<string, unknown>) => {
      if (!env || typeof env.kind !== "string") return;

      switch (env.kind) {
        case "focus-request": {
          const target = env.target;
          if (typeof target === "string") {
            const result = focusController.setFocus(target);
            if (!result.ok) {
              process.stderr.write(`mesh-mux: focus-request rejected: ${result.reason}\n`);
            }
          }
          break;
        }

        case "tail-toggle": {
          busTailState.on = Boolean(env.on);
          busTailState.filter = typeof env.filter === "string" ? env.filter : undefined;
          if (!busTailState.on) busTailBuffer.clear();
          // Re-broadcast to all peers
          const broadcast = makeTailToggleEnvelope({
            on: busTailState.on,
            ...(busTailState.filter !== undefined ? { filter: busTailState.filter } : {}),
          });
          launcherSock.broadcast(broadcast);
          break;
        }

        case "tail-event": {
          if (busTailState.on) {
            busTailBuffer.push({
              ts: typeof env.ts === "number" ? env.ts : Date.now(),
              sender: typeof env.sender === "string" ? env.sender : "?",
              recipient: typeof env.recipient === "string" ? env.recipient : "?",
              envKind: typeof env.envKind === "string" ? env.envKind : "?",
              body: typeof env.body === "string" ? env.body : "",
              direction: "in",
            });
          }
          break;
        }

        case "decision-pending": {
          const peerName = typeof env.peer === "string" ? env.peer : null;
          const on = Boolean(env.on);
          if (peerName) {
            focusController.setPeerDecisionPending(peerName, on);
          }
          break;
        }

        case "pin-request": {
          const msg_id = typeof env.msg_id === "string" ? env.msg_id : null;
          const peer = typeof env.peer === "string" ? env.peer : null;
          const kind = typeof env.kind_of_decision === "string" ? env.kind_of_decision : "unknown";
          const summary = typeof env.summary === "string" ? env.summary : "";
          if (msg_id && peer) {
            decisionsQueue.enqueue({ msg_id, peer, kind, summary });
            decisionsQueue.pin(msg_id);
          }
          break;
        }

        case "decisions-jump": {
          // Log; full TUI panel focus deferred
          const from = typeof env.from === "string" ? env.from : "?";
          process.stderr.write(
            `mesh-mux: decisions-jump from "${from}": ${decisionsQueue.count()} item(s) in queue\n`,
          );
          break;
        }

        case "spawn-request": {
          // Find the client connection so we can reply with spawn-result.
          // We reply by broadcasting with in_reply_to matching the msg_id.
          const msgId = env.msg_id as string;
          const result = await handleSpawnRequest(state, env, hostName, busRoot, debug);
          const spawnResult = makeSpawnResultEnvelope({
            msg_id: randomUUID(),
            in_reply_to: msgId,
            ok: result.ok,
            ...(result.name !== undefined ? { name: result.name } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          });
          // Reply only to the spawning peer's connected client (broadcast is fine
          // since spawn-result carries in_reply_to for correlation by launcher-bridge).
          launcherSock.broadcast(spawnResult);
          break;
        }

        case "kill-request": {
          const target = typeof env.target === "string" ? env.target : null;
          const from = typeof env.from === "string" ? env.from : "?";
          if (target) {
            if (debug) {
              process.stderr.write(`mesh-mux: kill-request from "${from}" for "${target}"\n`);
            }
            // Send shutdown bus envelope to the target
            if (busRoot) {
              const shutdownEnv = makeShutdownEnvelope({
                from: hostName,
                to: target,
                reason: `terminated by kill-request from ${from}`,
              });
              await sendOverBus(busRoot, target, encodeBusEnvelope(shutdownEnv), 500).catch(() => {});
            }
            // Pool-kill
            await pool.kill(target).catch(() => {});

            // Clean up state
            const peer = state.peers.get(target);
            if (peer) {
              state.peers.delete(target);
              focusController.unregisterPeer(target);
              if (peer.scratchRoot) {
                try { fs.rmSync(peer.scratchRoot, { recursive: true, force: true }); } catch { /* noop */ }
              }
            }
          }
          break;
        }

        default:
          break;
      }
    });

    // ── Register the direct spawn hook for in-process calls ──────────────────
    // mesh-spawn.ts checks for globalThis.__pi_mesh_mux_spawn__ before using
    // launcher-bridge, so when the host's model itself calls mesh_spawn we
    // bypass the round-trip.

    const g = globalThis as { __pi_mesh_mux_spawn__?: (req: Record<string, unknown>) => Promise<{ ok: boolean; name?: string; error?: string }> };
    g.__pi_mesh_mux_spawn__ = async (req: Record<string, unknown>) => {
      return handleSpawnRequest(state, req, hostName, busRoot, debug);
    };

    // ── Process initial_mesh: ────────────────────────────────────────────────

    await processInitialMesh(state, hostName, busRoot, debug, ctx);

    if (debug) {
      ctx.ui.notify(
        `mesh-mux: active — bound ${busRoot}/__launcher__.sock, ` +
        `${state.peers.size} initial peer(s) spawned`,
        "info",
      );
    }
  });

  // ── session_shutdown: cascade-kill all spawned peers ─────────────────────

  pi.on("session_shutdown", async () => {
    const state = getMuxState();
    if (!state) return;

    let habitat;
    try {
      habitat = getHabitat();
    } catch {
      return;
    }
    if (!habitat.isHost) return;

    const hostName = habitat.instanceName;
    const busRoot = habitat.busRoot;

    // Send shutdown envelopes to all peers
    const peers = [...state.peers.values()];
    await Promise.all(
      peers.map(async (p) => {
        if (busRoot) {
          const env = makeShutdownEnvelope({
            from: hostName,
            to: p.name,
            reason: "host session_shutdown",
          });
          await sendOverBus(busRoot, p.name, encodeBusEnvelope(env), 500).catch(() => {});
        }
      }),
    );

    // Wait ~2s then force-kill via pool
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    await state.pool.killAll().catch(() => {});

    // Close launcher socket
    try { await state.launcherSock.close(); } catch { /* ignore */ }

    // Detach mux
    if (state.mux) {
      try { state.mux.detach?.(); } catch { /* ignore */ }
    }

    // Remove the direct spawn hook
    const g = globalThis as { __pi_mesh_mux_spawn__?: unknown };
    delete g.__pi_mesh_mux_spawn__;

    // Clean up scratch roots
    for (const p of peers) {
      if (p.scratchRoot) {
        try { fs.rmSync(p.scratchRoot, { recursive: true, force: true }); } catch { /* noop */ }
      }
    }
  });
}
