// peer-spawn.ts — shared engine library for spawning child pi agents.
//
// Extracted from pi-sandbox/.pi/extensions/_lib/atomic-delegate.ts with
// habitat-overlay field names modernized to the new vocabulary:
//   submitTo         → submitsWorkTo
//   acceptedFrom     → acceptsWorkFrom
//   peers            → messagesWith
//   agents           → spawns
//
// Exports:
//   runAtomicDelegate  — atomic submission-wait flow (delegate tool)
//   runMeshSpawn       — long-lived background worker (mesh_spawn tool)
//   computeWorkerHabitatOverlay — shared overlay builder
//   copyWorkspace      — workspace bundling helper
//
// OQ-2 fix: when serializing the habitat overlay to --topology-overlay JSON,
// the key MUST be `escalatesTo` (not `supervisor`) because mergeTopologyOverlay
// in build-habitat.ts reads `overlay.escalatesTo`, not `overlay.supervisor`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Artifact } from "./bus-envelope.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SpawnArgs {
  workerName: string;
  recipe: string;
  scratchRoot: string;
  busRoot: string;
  task: string;
  habitatOverlay: {
    /** Caller's name — serializes to `escalatesTo` in the topology overlay JSON. */
    supervisor: string;
    submitsWorkTo: string;
    acceptsWorkFrom: string[];
    messagesWith: string[];
    spawns: string[];
  };
}

export interface WorkerHandle {
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (sig?: NodeJS.Signals) => void;
}

/** Globally-shared registry that lets agent-bus route inbound submissions
 *  back to the right `runAtomicDelegate` invocation. The production wiring
 *  is backed by globalThis; tests pass an in-memory map. */
export interface DispatchHookRegistry {
  register(workerName: string, onSubmission: (artifacts: Artifact[]) => void): void;
  unregister(workerName: string): void;
}

// ---------------------------------------------------------------------------
// runAtomicDelegate types
// ---------------------------------------------------------------------------

export interface PeerSpawnContext {
  recipe: string;
  task: string;
  /** Caller's instance name on the bus; becomes worker's supervisor/submitsWorkTo/acceptsWorkFrom/messagesWith. */
  callerName: string;
  /** Caller's canonical sandbox root; only used by the extension layer for apply. */
  callerSandbox: string;
  /** Bus root the worker should bind to. */
  busRoot: string;
  /** Optional read-only workspace bundle. */
  workspace?: { include: string[] };
  /** Total runtime budget in ms; defaults to 5 minutes. */
  timeoutMs?: number;
  spawnWorker: (args: SpawnArgs) => WorkerHandle;
  dispatchHookRegistry: DispatchHookRegistry;
  /** Override the auto-generated worker name; used by tests. */
  nameGenerator?: () => string;
}

export interface PeerSpawnResult {
  ok: boolean;
  workerName: string;
  /** Tmpdir created for the worker. The caller is expected to clean it up
   *  after applying any artifacts; runAtomicDelegate does NOT remove it
   *  itself so callers can inspect it during debugging. */
  scratchRoot: string;
  artifacts: Artifact[];
  workerStdout: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// runMeshSpawn types
// ---------------------------------------------------------------------------

export interface MeshSpawnContext {
  recipe: string;
  workerName: string;
  busRoot: string;
  task?: string;
  workspace?: { include: string[] };
  callerSandbox: string;
  callerName: string;
  spawnWorker: (args: SpawnArgs) => WorkerHandle;
}

export interface MeshSpawnResult {
  ok: boolean;
  workerName: string;
  scratchRoot: string;
  handle: WorkerHandle;
  error?: string;
}

// ---------------------------------------------------------------------------
// Shared: computeWorkerHabitatOverlay
// ---------------------------------------------------------------------------

/** Returns the habitat overlay a caller should apply to a spawned worker.
 *  Uses the new vocabulary field names. When serializing to
 *  --topology-overlay JSON, `supervisor` maps to `escalatesTo`.
 */
export function computeWorkerHabitatOverlay(callerName: string): SpawnArgs["habitatOverlay"] {
  return {
    supervisor: callerName,
    submitsWorkTo: callerName,
    acceptsWorkFrom: [callerName],
    messagesWith: [callerName],
    spawns: [],
  };
}

/** Serialize a habitat overlay to the JSON string for --topology-overlay.
 *  Maps `supervisor` → `escalatesTo` per mergeTopologyOverlay's expected keys.
 */
export function serializeHabitatOverlay(overlay: SpawnArgs["habitatOverlay"]): string {
  return JSON.stringify({
    escalatesTo: overlay.supervisor,
    submitsWorkTo: overlay.submitsWorkTo,
    acceptsWorkFrom: overlay.acceptsWorkFrom,
    messagesWith: overlay.messagesWith,
    spawns: overlay.spawns,
  });
}

// ---------------------------------------------------------------------------
// copyWorkspace
// ---------------------------------------------------------------------------

export function copyWorkspace(callerSandbox: string, scratchRoot: string, include: string[]): void {
  for (const rel of include) {
    const src = path.resolve(callerSandbox, rel);
    if (!src.startsWith(path.resolve(callerSandbox) + path.sep) && src !== path.resolve(callerSandbox)) {
      // Reject paths that escape the caller sandbox.
      continue;
    }
    if (!fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    const dst = path.join(scratchRoot, rel);
    if (stat.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        copyWorkspace(callerSandbox, scratchRoot, [path.join(rel, entry)]);
      }
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

// ---------------------------------------------------------------------------
// runAtomicDelegate
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export async function runAtomicDelegate(ctx: PeerSpawnContext): Promise<PeerSpawnResult> {
  const workerName = ctx.nameGenerator ? ctx.nameGenerator() : `worker-${Date.now()}`;
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pi-delegate-${workerName}-`));

  if (ctx.workspace?.include?.length) {
    copyWorkspace(ctx.callerSandbox, scratchRoot, ctx.workspace.include);
  }

  let resolveSubmission!: (artifacts: Artifact[]) => void;
  const submissionPromise = new Promise<Artifact[]>((resolve) => {
    resolveSubmission = resolve;
  });

  ctx.dispatchHookRegistry.register(workerName, (artifacts) => {
    resolveSubmission(artifacts);
  });

  const habitatOverlay = computeWorkerHabitatOverlay(ctx.callerName);

  const spawnArgs: SpawnArgs = {
    workerName,
    recipe: ctx.recipe,
    scratchRoot,
    busRoot: ctx.busRoot,
    task: ctx.task,
    habitatOverlay,
  };

  const handle = ctx.spawnWorker(spawnArgs);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const exitPromise = handle.exited.then((exit) => ({ exit }));

  const outcome = await Promise.race([
    submissionPromise.then((artifacts) => ({ kind: "submission" as const, artifacts })),
    exitPromise.then(({ exit }) => ({ kind: "exit" as const, exit })),
    timeoutPromise.then(() => ({ kind: "timeout" as const })),
  ]);

  if (timer) clearTimeout(timer);
  ctx.dispatchHookRegistry.unregister(workerName);

  if (outcome.kind === "submission") {
    try { handle.kill("SIGTERM"); } catch { /* noop */ }
    return {
      ok: true,
      workerName,
      scratchRoot,
      artifacts: outcome.artifacts,
      workerStdout: "",
    };
  }

  if (outcome.kind === "exit") {
    return {
      ok: false,
      workerName,
      scratchRoot,
      artifacts: [],
      workerStdout: "",
      error: `worker exited without submission (code=${outcome.exit.code} signal=${outcome.exit.signal ?? "none"})`,
    };
  }

  // timeout
  try { handle.kill("SIGTERM"); } catch { /* noop */ }
  return {
    ok: false,
    workerName,
    scratchRoot,
    artifacts: [],
    workerStdout: "",
    error: `worker timed out after ${timeoutMs}ms`,
  };
}

// ---------------------------------------------------------------------------
// runMeshSpawn — long-lived worker (no submission-wait)
// ---------------------------------------------------------------------------

export async function runMeshSpawn(ctx: MeshSpawnContext): Promise<MeshSpawnResult> {
  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-mesh-${ctx.workerName}-`),
  );

  if (ctx.workspace?.include?.length) {
    copyWorkspace(ctx.callerSandbox, scratchRoot, ctx.workspace.include);
  }

  const habitatOverlay = computeWorkerHabitatOverlay(ctx.callerName);

  const spawnArgs: SpawnArgs = {
    workerName: ctx.workerName,
    recipe: ctx.recipe,
    scratchRoot,
    busRoot: ctx.busRoot,
    task: ctx.task ?? "",
    habitatOverlay,
  };

  try {
    const handle = ctx.spawnWorker(spawnArgs);
    return {
      ok: true,
      workerName: ctx.workerName,
      scratchRoot,
      handle,
    };
  } catch (e) {
    // Clean up scratch if spawn fails
    try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* noop */ }
    return {
      ok: false,
      workerName: ctx.workerName,
      scratchRoot,
      handle: null as unknown as WorkerHandle,
      error: `spawn failed: ${(e as Error).message}`,
    };
  }
}
