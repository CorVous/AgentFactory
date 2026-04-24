// delegate.ts — generic parent-side runtime for a single-child sub-pi call.
//
// Phase 2.2 of the parts-first plan. Consumes the `parentSide` surface each
// component grew in Phase 2.1 (see `../components/_parent-side.ts`) and
// collapses the spawn/NDJSON/harvest/validate/promote boilerplate that
// was formerly re-authored in every extension. A canonical thin agent
// becomes `await delegate(ctx, { components: [...], prompt })`.
//
// Covers two composition topologies out of the box:
//   - single-spawn
//   - sequential-phases-with-brief (caller invokes delegate twice, passes
//     the first call's summaries into the second call's prompt)
//
// The RPC delegator-over-concurrent-drafters shape stays bespoke; the
// orchestrator imports per-component harvesters from `parentSide` but
// authors its own dispatch→review loop (plan §40-2.2).
//
// All rails from `pi-sandbox/skills/pi-agent-builder/references/defaults.md`
// are baked in — timeout (SIGKILL), --mode json, --no-extensions,
// --no-session, --thinking off, cost extraction from message_end,
// sha256 post-write verify, MAX_FILES_PROMOTABLE cap, path validation
// (done by the stage-write component's finalize), forbidden-tool check.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  NDJSONEvent,
  ParentSide,
  StageWriteResult,
  StagedWritePlan,
  UiCtx,
} from "../components/_parent-side.ts";

// Matches the orchestrator's drafter timeout from the pre-delegate era
// (`delegated-writer.ts::DRAFTER_TIMEOUT_MS`). The delegated-writer's
// RPC-phase calls stay on 120s because they don't go through delegate()
// — this ceiling is for drafter/scout/recon children only, and 180s is
// a proven envelope across all three `$AGENT_BUILDER_TARGETS`.
const PHASE_TIMEOUT_MS = 180_000;
const MAX_FILES_PROMOTABLE = 50;
const PREVIEW_LINES_PER_FILE = 20;
const FORBIDDEN_TOOLS = new Set(["write", "edit", "bash"]);

export interface DelegateOpts {
  components: ReadonlyArray<ParentSide<any, unknown>>;
  prompt: string;
  /** Override the tier-inferred model. Default: `$LEAD_MODEL` if review or
   *  run-deferred-writer are in the component set, else `$TASK_MODEL`. */
  model?: string;
  /** Extra tokens to union into the child's --tools CSV. Rarely needed. */
  extraTools?: string[];
  /** When `false`, skip the rails.md §10 confirm/promote step — the caller
   *  receives validated plans via `byComponent.get("stage-write")` and is
   *  responsible for promotion (possibly after an external review phase).
   *  Default `true`. The RPC orchestrator in
   *  `pi-sandbox/.pi/extensions/delegated-writer.ts` sets this `false` on
   *  its drafter spawns because its LLM reviewer is the gate, not the
   *  human confirm prompt. */
  autoPromote?: boolean;
}

export interface DelegateResult {
  exitCode: number;
  timedOut: boolean;
  stderr: string;
  costUsd: number;
  /** Final assistant message text (last `message_end` with role=assistant). */
  assistantText: string;
  /** Absolute paths of files written to disk after the rails.md §10 gate. */
  promoted: string[];
  /** Per-item validation + promotion failure reasons. */
  skips: string[];
  /** Each component's finalize() result, keyed by component name. */
  byComponent: Map<string, unknown>;
}

export async function delegate(
  ctx: UiCtx,
  opts: DelegateOpts,
): Promise<DelegateResult> {
  const cwd = process.cwd();
  const names = new Set(opts.components.map((c) => c.name));

  const model = resolveModel(ctx, opts, names);
  if (!model) {
    return emptyResult("no model resolved");
  }

  const toolsCsv = unionTools(opts);
  const forbiddenHits = toolsCsv.split(",").filter((t) => FORBIDDEN_TOOLS.has(t));
  if (forbiddenHits.length > 0) {
    ctx.ui.notify(
      `delegate(): forbidden tool(s) in component union: ${forbiddenHits.join(",")}`,
      "error",
    );
    return emptyResult(`forbidden tools: ${forbiddenHits.join(",")}`);
  }

  const spawnArgs: string[] = [];
  for (const c of opts.components) spawnArgs.push(...c.spawnArgs);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const c of opts.components) Object.assign(env, c.env({ cwd }));

  const states = new Map<ParentSide, unknown>();
  for (const c of opts.components) states.set(c, c.initialState());

  ctx.ui.notify(
    `delegate → spawn pi (model=${model}, tools=${toolsCsv}, components=${[...names].join(",")})`,
    "info",
  );

  const childOutcome = await runChild({
    argv: [
      "--mode", "json",
      "--no-extensions",
      "--no-session",
      "--thinking", "off",
      "--provider", "openrouter",
      "--model", model,
      "--tools", toolsCsv,
      ...spawnArgs,
      "-p", opts.prompt,
    ],
    cwd,
    env,
    components: opts.components,
    states,
  });

  // Finalize every component; aggregate by name.
  const byComponent = new Map<string, unknown>();
  for (const c of opts.components) {
    const r = await c.finalize(states.get(c) as never, { ctx, sandboxRoot: cwd });
    byComponent.set(c.name, r);
  }

  // rails.md §10: promote staged writes (if any) through the confirm gate
  // when stage-write ∈ components && review ∉ components. When review is
  // declared alongside stage-write the LLM verdict is the gate; delegate()
  // itself doesn't run a single-child review loop, so that combination is
  // treated as "defer to caller" — plans are returned via byComponent and
  // nothing is promoted automatically. Callers can also opt out of
  // promotion unconditionally via `opts.autoPromote: false`.
  const autoPromote = opts.autoPromote ?? true;
  const { promoted, skips } = autoPromote
    ? await promoteStagedWrites(ctx, byComponent, names)
    : { promoted: [], skips: getStageSkips(byComponent) };

  if (childOutcome.timedOut) {
    ctx.ui.notify(
      `delegate → child timed out after ${PHASE_TIMEOUT_MS / 1000}s`,
      "error",
    );
  } else if (childOutcome.exitCode !== 0) {
    ctx.ui.notify(
      `delegate → child exited ${childOutcome.exitCode}. stderr tail: ${childOutcome.stderr.slice(-500)}`,
      "error",
    );
  } else {
    ctx.ui.notify(
      `delegate → done (promoted=${promoted.length}, skips=${skips.length}, cost=$${childOutcome.costUsd.toFixed(4)})`,
      "info",
    );
  }

  return {
    exitCode: childOutcome.exitCode,
    timedOut: childOutcome.timedOut,
    stderr: childOutcome.stderr,
    costUsd: childOutcome.costUsd,
    assistantText: childOutcome.assistantText,
    promoted,
    skips,
    byComponent,
  };
}

// ---------- internals ----------

function resolveModel(
  ctx: UiCtx,
  opts: DelegateOpts,
  names: Set<string>,
): string | undefined {
  if (opts.model) return opts.model;
  const needsLead = names.has("review") || names.has("run-deferred-writer");
  const tierVar = needsLead ? "LEAD_MODEL" : "TASK_MODEL";
  const value = process.env[tierVar];
  if (!value) {
    ctx.ui.notify(
      `delegate(): ${tierVar} env var not set. Source models.env first.`,
      "error",
    );
    return undefined;
  }
  return value;
}

function unionTools(opts: DelegateOpts): string {
  const set = new Set<string>();
  for (const c of opts.components) for (const t of c.tools) set.add(t);
  for (const t of opts.extraTools ?? []) set.add(t);
  return [...set].join(",");
}

interface ChildOutcome {
  exitCode: number;
  timedOut: boolean;
  stderr: string;
  costUsd: number;
  assistantText: string;
}

async function runChild(opts: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  components: ReadonlyArray<ParentSide<any, unknown>>;
  states: Map<ParentSide, unknown>;
}): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn("pi", opts.argv, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: opts.env,
    });

    let buffer = "";
    let stderr = "";
    let assistantText = "";
    let costUsd = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PHASE_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: NDJSONEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        // Dispatch every event to every component's harvester.
        for (const c of opts.components) {
          try {
            c.harvest(event, opts.states.get(c) as never);
          } catch {
            /* harvest callbacks must not throw; ignore defensively */
          }
        }
        // Cost + final assistant text come from message_end.
        if (event.type === "message_end") {
          const msg = event.message as
            | { role?: string; content?: unknown; usage?: { cost?: { total?: number } } }
            | undefined;
          const total = msg?.usage?.cost?.total;
          if (typeof total === "number" && isFinite(total)) costUsd += total;
          if (msg?.role === "assistant" && Array.isArray(msg.content)) {
            let text = "";
            for (const part of msg.content as Array<{ type?: string; text?: string }>) {
              if (part?.type === "text" && typeof part.text === "string") text += part.text;
            }
            if (text) assistantText = text;
          }
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 0,
        timedOut,
        stderr,
        costUsd,
        assistantText,
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        timedOut,
        stderr,
        costUsd,
        assistantText,
      });
    });
  });
}

async function promoteStagedWrites(
  ctx: UiCtx,
  byComponent: Map<string, unknown>,
  names: Set<string>,
): Promise<{ promoted: string[]; skips: string[] }> {
  const promoted: string[] = [];
  const skips: string[] = [];
  if (!names.has("stage-write")) return { promoted, skips };
  const sw = byComponent.get("stage-write") as StageWriteResult | undefined;
  if (!sw) return { promoted, skips };

  skips.push(...sw.skips);
  if (sw.plans.length === 0) return { promoted, skips };

  if (sw.plans.length > MAX_FILES_PROMOTABLE) {
    ctx.ui.notify(
      `delegate → ${sw.plans.length} staged files > MAX_FILES_PROMOTABLE (${MAX_FILES_PROMOTABLE}); aborting`,
      "error",
    );
    return { promoted, skips };
  }

  // rails.md §10: LLM-review path defers to caller.
  if (names.has("review")) return { promoted, skips };

  // Human confirm gate. `ctx.ui.confirm` is a no-op that returns false in
  // print mode (`-p`); extensions MUST exit cleanly on that branch per
  // the AGENTS.md note about the cancel path.
  if (!ctx.ui.confirm) {
    ctx.ui.notify(
      `delegate → ctx.ui.confirm unavailable; cancelling (nothing promoted)`,
      "info",
    );
    return { promoted, skips };
  }

  const preview = sw.plans
    .map((p) => {
      const header = `${p.destAbs} (${p.byteLength} bytes, sha ${p.sha.slice(0, 10)}…)`;
      const lines = p.content.split("\n");
      const shown = lines.slice(0, PREVIEW_LINES_PER_FILE).join("\n");
      const tail =
        lines.length > PREVIEW_LINES_PER_FILE
          ? `\n… (+${lines.length - PREVIEW_LINES_PER_FILE} more lines)`
          : "";
      return `${header}\n${shown}${tail}`;
    })
    .join("\n\n---\n\n");

  const ok = await ctx.ui.confirm(`Promote ${sw.plans.length} file(s)?`, preview);
  if (!ok) {
    ctx.ui.notify("delegate → cancelled; nothing promoted", "info");
    return { promoted, skips };
  }

  for (const p of sw.plans) {
    const result = promoteOne(p);
    if (result.ok) promoted.push(p.destAbs);
    else skips.push(`${p.relPath}: ${result.reason}`);
  }

  return { promoted, skips };
}

/** Promote a list of validated {@link StagedWritePlan}s to disk with a
 *  sha256 post-write verify, respecting the MAX_FILES_PROMOTABLE cap.
 *  Exported so orchestrators that bypass `delegate()`'s built-in confirm
 *  gate (e.g. the RPC delegator) can still reuse the safe-write path. */
export function promote(
  ctx: UiCtx,
  plans: ReadonlyArray<StagedWritePlan>,
): { promoted: string[]; skips: string[] } {
  const promoted: string[] = [];
  const skips: string[] = [];
  if (plans.length === 0) return { promoted, skips };
  if (plans.length > MAX_FILES_PROMOTABLE) {
    ctx.ui.notify(
      `promote() → ${plans.length} plans > MAX_FILES_PROMOTABLE (${MAX_FILES_PROMOTABLE}); aborting`,
      "error",
    );
    return { promoted, skips };
  }
  for (const p of plans) {
    const r = promoteOne(p);
    if (r.ok) promoted.push(p.destAbs);
    else skips.push(`${p.relPath}: ${r.reason}`);
  }
  return { promoted, skips };
}

function getStageSkips(byComponent: Map<string, unknown>): string[] {
  const sw = byComponent.get("stage-write") as StageWriteResult | undefined;
  return sw ? [...sw.skips] : [];
}

function promoteOne(p: StagedWritePlan): { ok: true } | { ok: false; reason: string } {
  if (fs.existsSync(p.destAbs)) {
    return { ok: false, reason: "destination now exists" };
  }
  try {
    fs.mkdirSync(path.dirname(p.destAbs), { recursive: true });
    fs.writeFileSync(p.destAbs, p.content, "utf8");
    const actualSha = createHash("sha256")
      .update(fs.readFileSync(p.destAbs, "utf8"), "utf8")
      .digest("hex");
    if (actualSha !== p.sha) {
      return { ok: false, reason: "sha256 mismatch after write" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function emptyResult(reason: string): DelegateResult {
  return {
    exitCode: -1,
    timedOut: false,
    stderr: reason,
    costUsd: 0,
    assistantText: "",
    promoted: [],
    skips: [reason],
    byComponent: new Map(),
  };
}
