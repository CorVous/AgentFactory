// _parent-side.ts — shape of the parent-side surface each component exports.
//
// Phase 2.1 of the parts-first plan. Until this file landed, every component
// shipped only the child-side stub tool (its default-exported factory). The
// ~80-line spawn/NDJSON-parse/harvest/promote boilerplate that drives those
// stubs had to be re-authored in every agent file. This module defines the
// shape of a named `parentSide` export that each component now adds, so the
// upcoming `delegate()` runtime (Phase 2.2) can drive the child generically:
// union the tool allowlists, concatenate the `-e` flags, merge env, dispatch
// NDJSON events to each component's harvest callback, then run each
// component's finalize after the child exits.
//
// Leading underscore keeps this out of pi's extension auto-discovery — the
// file exports only types (interfaces + aliases), no runtime values, so
// consumers should import with `import type`.

/** A single parsed line from the child's `--mode json` stdout. */
export type NDJSONEvent = Record<string, unknown>;

/** Subset of the pi handler context the components touch. Mirrors the
 *  ad-hoc `UiCtx` local type currently duplicated across canonical
 *  extensions (`deferred-writer.ts`, `delegated-writer.ts`).
 *  `confirm` / `setWidget` / `setStatus` are optional because print-mode
 *  pi (`-p`) stubs them out; every consumer must null-check.
 *
 *  `hasUI` mirrors `ExtensionContext.hasUI` from pi's SDK. It is `true`
 *  in interactive mode and `false` in print/RPC mode (where the runner
 *  routes through `noOpUIContext`). Components branch on it to decide
 *  whether to gate via `confirm` or to defer staging to a parent that
 *  may itself have a TUI. Optional for backward-compat with hand-rolled
 *  extension contexts that haven't widened to expose it; new gating
 *  logic should treat `undefined` as "unknown — assume no UI". */
export interface UiCtx {
  ui: {
    notify: (m: string, level: "info" | "warning" | "error") => void;
    confirm?: (title: string, body: string) => Promise<boolean>;
    setWidget?: (key: string, content: string[] | undefined) => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
  hasUI?: boolean;
}

/** Runtime context passed into each component's `env(...)` factory at
 *  child-spawn time. Kept as a named type so new context keys (e.g. a
 *  per-run scratch dir) can be added without breaking the signature. */
export interface EnvContext {
  /** Absolute cwd the child pi will run in — becomes `PI_SANDBOX_ROOT`
   *  for cwd-guard, and typically matches the sandbox root. */
  cwd: string;
}

/** Context passed into `finalize`. `sandboxRoot` mirrors the cwd the
 *  child ran in; path-validation in component finalizes anchors off it. */
export interface FinalizeContext {
  ctx: UiCtx;
  sandboxRoot: string;
}

/** Parent-side surface of a component.
 *
 *  A delegate runtime typically walks an ordered list of these, in order:
 *    1. union `tools` into the child's --tools CSV
 *    2. concatenate `spawnArgs` onto the pi argv (usually `-e <abs path>`)
 *    3. merge `env(...)` output into the child's process env
 *    4. create per-component state via `initialState()`
 *    5. for each NDJSON line from the child's stdout, call every
 *       component's `harvest(event, state)`
 *    6. after the child exits, call every component's
 *       `finalize(state, ctx)` and aggregate the results.
 *
 *  State/Result are generic so each component can express its own shape
 *  without a union type; the runtime only needs `unknown` as the common
 *  denominator. */
export interface ParentSide<State = unknown, Result = unknown> {
  /** Stable identifier for the component. Used by `delegate()` to key
   *  per-component state + results, and to apply cross-component policy
   *  (rails.md §10 — confirm iff stage-write ∈ components && review ∉
   *  components). Must be unique within a single `delegate()` call. The
   *  canonical five are `cwd-guard`, `stage-write`, `emit-summary`,
   *  `review`, `run-deferred-writer`. */
  name: string;
  /** Tokens this component contributes to the child's --tools CSV. */
  tools: string[];
  /** Pi CLI args this component contributes (typically `-e <abs path>`). */
  spawnArgs: string[];
  /** Env vars the child needs when this component is loaded. Called at
   *  spawn time so values can reference the runtime cwd (cwd-guard uses
   *  this for PI_SANDBOX_ROOT). Return `{}` if the component needs none. */
  env: (ctx: EnvContext) => Record<string, string>;
  /** Construct a fresh per-run state. Called once per child invocation
   *  before the NDJSON loop starts. */
  initialState: () => State;
  /** Called synchronously for every parsed NDJSON event. Harvesters
   *  mutate `state` in place (push/assign) rather than returning a new
   *  one — matches the buffered-accumulator pattern already used across
   *  the canonical extensions. Must be a fast, non-throwing read path. */
  harvest: (event: NDJSONEvent, state: State) => void;
  /** Called after the child exits. Produces the component-specific
   *  structured result (validated plans, verdict map, summaries, etc.).
   *  May perform I/O (e.g. sha256 over content) but MUST NOT write to
   *  the filesystem — promotion is the delegate runtime's job, because
   *  the confirm/LLM-gate policy depends on which *other* components
   *  were loaded alongside this one (see rails.md §10). */
  finalize: (state: State, fctx: FinalizeContext) => Promise<Result> | Result;
}

// ---------------- per-component state/result types ----------------

// cwd-guard — parent has nothing to harvest. The child writes directly
// via sandbox_write/sandbox_edit, which the parent does not intercept.
export type CwdGuardState = Record<string, never>;
export type CwdGuardResult = Record<string, never>;

// stage-write — drafter child buffers writes in parent memory.
export interface RawStagedWrite {
  path: unknown;
  content: unknown;
}
export interface StageWriteState {
  stagedWrites: RawStagedWrite[];
}
/** A staged write that passed validation and is ready for promotion. */
export interface StagedWritePlan {
  relPath: string;
  destAbs: string;
  content: string;
  /** sha256 of `content` computed at finalize time; verified post-write. */
  sha: string;
  byteLength: number;
}
export interface StageWriteResult {
  plans: StagedWritePlan[];
  /** Per-item reasons a raw staged write failed validation. */
  skips: string[];
}

// emit-summary — child emits structured summaries for the parent to persist
// or feed into a sibling phase.
export interface RawSummary {
  title: unknown;
  body: unknown;
}
export interface EmitSummaryState {
  summaries: RawSummary[];
}
export interface Summary {
  title: string;
  body: string;
  byteLength: number;
}
export interface EmitSummaryResult {
  summaries: Summary[];
  skips: string[];
}

// review — delegator LLM returns verdicts per staged file.
export interface ReviewCall {
  file_path: string;
  verdict: "approve" | "revise";
  feedback?: string;
}
export interface ReviewState {
  reviews: ReviewCall[];
}
export interface ReviewResult {
  /** Last verdict per file_path wins — the delegator LLM is expected to
   *  emit exactly one review call per file, but dedup defensively. */
  verdictMap: Map<string, ReviewCall>;
  /** Preserved insertion order, useful for logging. */
  reviews: ReviewCall[];
}

// run-deferred-writer — delegator LLM dispatches one drafter per task.
export interface DispatchRequestsState {
  tasks: string[];
}
export interface DispatchRequestsResult {
  tasks: string[];
}

// emit-agent-spec — dual-mode. In a direct-human (ctx.hasUI=true)
// session, the child writes the YAML itself after an inline confirm,
// and the parent harvest records the file path for logs. In a sub-
// agent / print-mode (ctx.hasUI=false) session, the child returns
// `staged: true` without writing; the parent harvests the staged
// payload, runs its own confirm via fctx.ctx.ui.confirm, and writes
// the YAML iff approved.
export interface EmitAgentSpecStagedSpec {
  name: string;
  slash: string;
  composition: string;
  yaml: string;
}
export interface EmitAgentSpecState {
  staged: EmitAgentSpecStagedSpec[];
  childWrote: Array<{ name: string; path: string }>;
}
export interface EmitAgentSpecResult {
  written: Array<{ name: string; path: string }>;
  denied: Array<{ name: string; reason: string }>;
  errors: Array<{ name: string; reason: string }>;
}
