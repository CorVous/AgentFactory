// Atomic-delegate testable core. Owns: scratchRoot allocation, optional
// workspace bundling, dispatch-hook registration, race between
// submission/exit/timeout, and cleanup. Process spawn and the
// globalThis-backed dispatch registry are injected so this module is
// hermetic under `npm test`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Artifact } from "./bus-envelope";

export interface SpawnArgs {
  workerName: string;
  recipe: string;
  scratchRoot: string;
  busRoot: string;
  task: string;
  habitatOverlay: {
    supervisor: string;
    submitTo: string;
    acceptedFrom: string[];
    peers: string[];
    agents: string[];
  };
}

export interface WorkerHandle {
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (sig?: NodeJS.Signals) => void;
}

/** Globally-shared registry that lets agent-bus.ts route inbound submissions
 *  back to the right `runAtomicDelegate` invocation. The production wiring
 *  is backed by globalThis; tests pass an in-memory map. */
export interface DispatchHookRegistry {
  register(workerName: string, onSubmission: (artifacts: Artifact[]) => void): void;
  unregister(workerName: string): void;
}

export interface AtomicDelegateContext {
  recipe: string;
  task: string;
  /** Caller's instance name on the bus; becomes worker's supervisor/submitTo/acceptedFrom/peers. */
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

export interface DelegateResult {
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

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function copyWorkspace(callerSandbox: string, scratchRoot: string, include: string[]): void {
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

export async function runAtomicDelegate(ctx: AtomicDelegateContext): Promise<DelegateResult> {
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

  const spawnArgs: SpawnArgs = {
    workerName,
    recipe: ctx.recipe,
    scratchRoot,
    busRoot: ctx.busRoot,
    task: ctx.task,
    habitatOverlay: {
      supervisor: ctx.callerName,
      submitTo: ctx.callerName,
      acceptedFrom: [ctx.callerName],
      peers: [ctx.callerName],
      agents: [],
    },
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
