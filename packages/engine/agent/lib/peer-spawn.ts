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
//   parseRef           — ADR-0008 5-form reference grammar parser
//   classifyBareRef    — @<token> disambiguation helper (ADR §C)
//
// OQ-2 fix: when serializing the habitat overlay to --topology-overlay JSON,
// the key MUST be `escalatesTo` (not `supervisor`) because mergeTopologyOverlay
// in build-habitat.ts reads `overlay.escalatesTo`, not `overlay.supervisor`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Artifact } from "./bus-envelope.js";

// ---------------------------------------------------------------------------
// ADR-0008 reference grammar — ParsedRef discriminated union + parseRef
// ---------------------------------------------------------------------------

/** @group:<recipe> — instances of <recipe> in <group> */
export interface RefGroupRecipe {
  kind: "group-recipe";
  group: string;
  recipe: string;
}

/** @<group> — all peers in <group> regardless of recipe */
export interface RefGroup {
  kind: "group";
  group: string;
}

/** @<recipe> — short for @$myGroups:<recipe> (ADR §C) */
export interface RefRecipe {
  kind: "recipe";
  recipe: string;
}

/** @$myGroups — all peers in any group the resolving peer is a member of */
export interface RefMyGroups {
  kind: "my-groups";
}

/** @$myGroups:<recipe> — recipe-typed variant of @$myGroups */
export interface RefMyGroupsRecipe {
  kind: "my-groups-recipe";
  recipe: string;
}

/** A literal (non-@) peer name — pass-through */
export interface RefLiteral {
  kind: "literal";
  value: string;
}

export type ParsedRef =
  | RefGroupRecipe
  | RefGroup
  | RefRecipe
  | RefMyGroups
  | RefMyGroupsRecipe
  | RefLiteral;

/**
 * Parse an ADR-0008 reference string into a typed discriminated union.
 *
 * Recognised forms:
 *   @<group>:<recipe>   — RefGroupRecipe
 *   @<group>            — RefGroup
 *   @<recipe>           — RefRecipe (bare @<token> resolved as recipe-in-myGroups;
 *                         caller should use classifyBareRef for disambiguation)
 *   @$myGroups          — RefMyGroups
 *   @$myGroups:<recipe> — RefMyGroupsRecipe
 *   <literal>           — RefLiteral
 *
 * Throws on any malformed ref.
 */
export function parseRef(raw: string): ParsedRef {
  if (typeof raw !== "string") {
    throw new Error(`parseRef: ref must be a string, got ${typeof raw}`);
  }
  if (raw.includes(" ") || raw.includes("\t") || raw.includes("\n")) {
    throw new Error(`parseRef: ref must not contain whitespace: ${JSON.stringify(raw)}`);
  }
  if (raw === "") {
    throw new Error("parseRef: ref must not be empty");
  }

  // Literal (non-@)
  if (!raw.startsWith("@")) {
    return { kind: "literal", value: raw };
  }

  const body = raw.slice(1); // strip @

  if (body === "") {
    throw new Error(`parseRef: '@' alone is not a valid ref`);
  }

  // Count colons — more than one is malformed
  const colonCount = (body.match(/:/g) || []).length;
  if (colonCount > 1) {
    throw new Error(`parseRef: too many ':' separators in ref '${raw}'`);
  }

  const colonIdx = body.indexOf(":");

  if (colonIdx !== -1) {
    const left = body.slice(0, colonIdx);
    const right = body.slice(colonIdx + 1);

    if (left === "") throw new Error(`parseRef: empty group segment in ref '${raw}'`);
    if (right === "") throw new Error(`parseRef: empty recipe segment in ref '${raw}'`);

    // @$myGroups:<recipe>
    if (left === "$myGroups") {
      if (right.startsWith("$")) {
        throw new Error(`parseRef: unknown symbolic '${right}' in ref '${raw}'`);
      }
      return { kind: "my-groups-recipe", recipe: right };
    }

    // @<group>:<recipe>
    if (left.startsWith("$")) {
      throw new Error(`parseRef: unknown symbolic '${left}' in ref '${raw}'`);
    }
    return { kind: "group-recipe", group: left, recipe: right };
  }

  // No colon

  // @$myGroups
  if (body === "$myGroups") {
    return { kind: "my-groups" };
  }

  // Unknown @$<symbolic>
  if (body.startsWith("$")) {
    throw new Error(`parseRef: unknown symbolic '@${body}' — only @$myGroups is supported`);
  }

  // Bare @<token> — ambiguous between @<group> and @<recipe>.
  // Default to RefGroup. Callers that need disambiguation should use
  // classifyBareRef after parsing. At recipe-parse time, classifyBareRef
  // resolves the ambiguity against the recipe's known spawns/groups.
  return { kind: "group", group: body };
}

/**
 * Disambiguate a bare `@<token>` reference (ADR §C):
 *   - If `token` matches a reachable recipe name → RefRecipe
 *   - If `token` matches a declared group name  → RefGroup
 *   - If `token` matches BOTH                   → hard error
 *   - If `token` matches neither                → RefGroup (unknown group, caught at runtime)
 *
 * `reachableRecipes` — recipe names from the recipe's `spawns:` list.
 * `declaredGroups`   — group names declared anywhere in the recipe's context.
 */
export function classifyBareRef(
  token: string,
  reachableRecipes: string[],
  declaredGroups: string[],
): ParsedRef {
  const isRecipe = reachableRecipes.includes(token);
  const isGroup = declaredGroups.includes(token);

  if (isRecipe && isGroup) {
    throw new Error(
      `parseRef: '@${token}' is ambiguous — '${token}' is both a reachable recipe name ` +
      `and a declared group name. Disambiguate with '@${token}:${token}' (group:recipe form) ` +
      `or use a distinct group name.`,
    );
  }
  if (isRecipe) {
    return { kind: "recipe", recipe: token };
  }
  // Either known group or unknown (resolved at runtime)
  return { kind: "group", group: token };
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SpawnArgs {
  workerName: string;
  recipe: string;
  scratchRoot: string;
  busRoot: string;
  task: string;
  /** Group memberships for the spawned worker (seeded into its Habitat). */
  groups?: string[];
  habitatOverlay: {
    /** Caller's name — serializes to `escalatesTo` in the topology overlay JSON. */
    supervisor: string;
    submitsWorkTo: string;
    acceptsWorkFrom: string[];
    messagesWith: string[];
    spawns: string[];
    /** Group memberships for the spawned worker. */
    groups?: string[];
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
  /** Group memberships to assign to the spawned worker. */
  groups?: string[];
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
  const obj: Record<string, unknown> = {
    escalatesTo: overlay.supervisor,
    submitsWorkTo: overlay.submitsWorkTo,
    acceptsWorkFrom: overlay.acceptsWorkFrom,
    messagesWith: overlay.messagesWith,
    spawns: overlay.spawns,
  };
  if (overlay.groups !== undefined) {
    obj.groups = overlay.groups;
  }
  return JSON.stringify(obj);
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
  if (ctx.groups !== undefined) {
    habitatOverlay.groups = ctx.groups;
  }

  const spawnArgs: SpawnArgs = {
    workerName: ctx.workerName,
    recipe: ctx.recipe,
    scratchRoot,
    busRoot: ctx.busRoot,
    task: ctx.task ?? "",
    groups: ctx.groups,
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
