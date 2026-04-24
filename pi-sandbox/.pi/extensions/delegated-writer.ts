import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parentSide as CWD_GUARD } from "../components/cwd-guard.ts";
import { parentSide as REVIEW } from "../components/review.ts";
import { parentSide as RUN_DEFERRED_WRITER } from "../components/run-deferred-writer.ts";
import { parentSide as STAGE_WRITE } from "../components/stage-write.ts";
import type {
  DispatchRequestsState,
  ReviewCall,
  ReviewState,
  StageWriteResult,
  StagedWritePlan,
} from "../components/_parent-side.ts";
import { delegate, promote } from "../lib/delegate.ts";

const DELEGATOR_PHASE_TIMEOUT_MS = 120_000;
const MAX_SUBTASKS = 8;
const MAX_FILES_PROMOTABLE = 50;
const MAX_REVISE_ITERATIONS = 3;
const NOTIFY_TEXT_MAX = 400;
const DASHBOARD_KEY = "delegated-writer";
const TASK_PREVIEW_CHARS = 60;
const CONTENT_PREVIEW_LINES = 2;
const CONTENT_PREVIEW_CHARS = 80;
const WRITTEN_PREVIEW_LINES = 8;
const WRITTEN_PREVIEW_CHARS = 120;

/** A validated stage-write plan tagged with the drafter index that produced
 *  it. Extends the StagedWritePlan from `_parent-side.ts` with taskIndex so
 *  the review phase can attribute verdicts back to drafters for revision. */
type TaskStagedWrite = StagedWritePlan & { taskIndex: number };

type PhaseResult = {
  tasks: string[];
  reviews: ReviewCall[];
  timedOut: boolean;
  costUsd: number;
};

type UiCtx = {
  ui: {
    notify: (m: string, level: "info" | "warning" | "error") => void;
    setWidget?: (key: string, content: string[] | undefined) => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
};

type DrafterPhase = "pending" | "running" | "done" | "timed_out" | "error";
type PipelinePhase =
  | "dispatching" | "drafting" | "reviewing" | "revising" | "promoting" | "done" | "failed";

type DrafterState = {
  task: string;
  phase: DrafterPhase;
  stagedWrites: Array<{ path: string; content: string; bytes: number }>;
};

type PipelineState = {
  userGoal: string;
  phase: PipelinePhase;
  iteration: number;
  drafters: Map<number, DrafterState>;
  verdicts: Map<string, ReviewCall>;
  costs: { delegatorUsd: number; draftersUsd: number };
};

function extractCostUsd(ev: Record<string, unknown>): number {
  if (ev.type !== "message_end") return 0;
  const msg = ev.message as { usage?: { cost?: { total?: number } } } | undefined;
  const total = msg?.usage?.cost?.total;
  return typeof total === "number" && isFinite(total) ? total : 0;
}

const fmtUsd = (n: number) => `$${n.toFixed(4)}`;

const trunc = (s: string, n = NOTIFY_TEXT_MAX) =>
  s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;

const PHASE_EMOJI: Record<DrafterPhase, string> = {
  pending: "⏸",
  running: "🔄",
  done: "✅",
  timed_out: "⏱",
  error: "⚠",
};

function renderDashboard(state: PipelineState): string[] {
  const lines: string[] = [];
  const goalShort = trunc(state.userGoal, 70);
  lines.push(`/delegated-writer · iter ${state.iteration}/${MAX_REVISE_ITERATIONS} · ${state.phase}`);
  lines.push(`goal: ${goalShort}`);
  lines.push("─".repeat(48));

  if (state.drafters.size === 0) {
    lines.push("(no drafters dispatched yet)");
    return lines;
  }

  const indices = Array.from(state.drafters.keys()).sort((a, b) => a - b);
  for (const i of indices) {
    const d = state.drafters.get(i)!;
    const emoji = PHASE_EMOJI[d.phase];
    const taskShort = trunc(d.task, TASK_PREVIEW_CHARS);
    lines.push(`[${i + 1}] ${emoji} ${d.phase}  "${taskShort}"`);
    if (d.stagedWrites.length === 0) {
      if (d.phase === "running" || d.phase === "pending") {
        lines.push("    └─ (no drafts yet)");
      } else {
        lines.push("    └─ (no files staged)");
      }
      continue;
    }
    for (let j = 0; j < d.stagedWrites.length; j++) {
      const w = d.stagedWrites[j];
      const isLast = j === d.stagedWrites.length - 1;
      const prefix = isLast ? "└─" : "├─";
      const verdict = state.verdicts.get(w.path);
      const verdictTag = verdict
        ? verdict.verdict === "approve"
          ? "  · ✅ approve"
          : `  · ✳ revise: ${trunc(verdict.feedback ?? "(no feedback)", 50)}`
        : "";
      lines.push(`    ${prefix} ${w.path} (${w.bytes} b)${verdictTag}`);
      const contentLines = w.content.split("\n").slice(0, CONTENT_PREVIEW_LINES);
      for (const cl of contentLines) {
        const clTrim = trunc(cl, CONTENT_PREVIEW_CHARS);
        lines.push(`       ${clTrim}`);
      }
      if (w.content.split("\n").length > CONTENT_PREVIEW_LINES) {
        lines.push(`       …`);
      }
    }
  }
  return lines;
}

function updateDashboard(ctx: UiCtx, state: PipelineState) {
  if (!ctx.ui.setWidget) return;
  try { ctx.ui.setWidget(DASHBOARD_KEY, renderDashboard(state)); } catch {}
}

function clearDashboard(ctx: UiCtx) {
  if (!ctx.ui.setWidget) return;
  try { ctx.ui.setWidget(DASHBOARD_KEY, undefined); } catch {}
}

function renderStatus(state: PipelineState): string {
  const total = state.drafters.size;
  const done = Array.from(state.drafters.values()).filter(d => d.phase === "done").length;
  const totalCost = state.costs.delegatorUsd + state.costs.draftersUsd;
  return `delegated-writer · ${state.phase} · iter ${state.iteration}/${MAX_REVISE_ITERATIONS} · drafters ${done}/${total} · ${fmtUsd(totalCost)}`;
}

function updateStatus(ctx: UiCtx, state: PipelineState) {
  if (!ctx.ui.setStatus) return;
  try { ctx.ui.setStatus(DASHBOARD_KEY, renderStatus(state)); } catch {}
}

// Drafter result shape after delegate() validation. `plans` are already
// sandbox-checked / dedup-checked / sha-computed by stage-write.finalize;
// the orchestrator assigns taskIndex and merges duplicates across tasks.
type DrafterOutcome = {
  plans: StagedWritePlan[];
  skips: string[];
  timedOut: boolean;
  exitCode: number;
  stderr: string;
  costUsd: number;
};

// Drafter goes through delegate(autoPromote: false) so the LLM reviewer —
// not ctx.ui.confirm — is the gate. Uses CWD_GUARD alongside STAGE_WRITE
// because drafters may call `read` / `ls` on sandbox paths and the guard
// supplies the tool allowlist contribution for those verbs plus the
// PI_SANDBOX_ROOT env. `onStage` wraps STAGE_WRITE.harvest so the
// per-stage_write dashboard update still fires live rather than batched
// at child-close.
async function runDrafter(
  task: string,
  feedback: string[] | undefined,
  ctx: UiCtx,
  onStage?: (w: { path: string; content: string; bytes: number }) => void,
): Promise<DrafterOutcome> {
  const sandboxRoot = path.resolve(process.cwd());
  const base = `You are a DRAFTER. Task: ${task}.
To create a file, call 'stage_write' with a relative 'path' (inside the project at ${sandboxRoot}) and full 'content'. Nothing touches disk until approved.

Rules:
- Only 'stage_write'. No real write tools.
- Paths relative, inside ${sandboxRoot}, no '..'.
- Use 'read' / 'ls' on absolute paths under ${sandboxRoot} to explore.
- Stop after staging everything. Reply DONE.`;
  const prompt = feedback && feedback.length > 0
    ? `${base}\n\nThis is a REVISION pass. Previous attempt had issues. Apply this feedback verbatim:\n${feedback.map(f => `- ${f}`).join("\n")}`
    : base;

  const stageHook = onStage
    ? {
        ...STAGE_WRITE,
        harvest(event: Record<string, unknown>, state: unknown) {
          STAGE_WRITE.harvest(event, state as never);
          if (
            event.type !== "tool_execution_start" ||
            event.toolName !== "stage_write"
          ) return;
          const args = event.args as { path?: unknown; content?: unknown } | undefined;
          if (!args || typeof args.path !== "string") return;
          const content = typeof args.content === "string" ? args.content : "";
          onStage({
            path: args.path,
            content,
            bytes: Buffer.byteLength(content, "utf8"),
          });
        },
      }
    : STAGE_WRITE;

  const result = await delegate(ctx, {
    components: [CWD_GUARD, stageHook],
    prompt,
    autoPromote: false,
  });

  const sw = result.byComponent.get("stage-write") as StageWriteResult | undefined;
  return {
    plans: sw?.plans ?? [],
    skips: sw?.skips ?? [],
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    stderr: result.stderr,
    costUsd: result.costUsd,
  };
}

// Single persistent RPC-mode pi child, driven through multiple prompt/phase turns.
class DelegatorSession {
  private child: ChildProcess;
  private buffer = "";
  private stderr = "";
  private listeners = new Set<(ev: Record<string, unknown>) => void>();
  private closed = false;

  constructor(leadModel: string, sandboxRoot: string) {
    // -e flags and --tools CSV come from parentSide contributions so the
    // RPC delegator shares its "how to load these stubs" knowledge with
    // the rest of the composer library (rails.md §1, §8).
    const spawnArgs = [...RUN_DEFERRED_WRITER.spawnArgs, ...REVIEW.spawnArgs];
    const tools = [...RUN_DEFERRED_WRITER.tools, ...REVIEW.tools].join(",");
    this.child = spawn("pi", [
      "--mode", "rpc",
      "--no-extensions", "--no-session", "--no-context-files",
      "--thinking", "off",
      ...spawnArgs,
      "--tools", tools,
      "--provider", "openrouter", "--model", leadModel,
    ], { stdio: ["pipe", "pipe", "pipe"], cwd: sandboxRoot });

    this.child.stdout!.on("data", (d) => this.onStdout(d));
    this.child.stderr!.on("data", (d) => { this.stderr += d.toString(); });
    this.child.on("close", () => { this.closed = true; });
    this.child.on("error", () => { this.closed = true; });
  }

  private onStdout(d: Buffer) {
    this.buffer += d.toString();
    // RPC is strict JSONL with \n only; strip trailing \r.
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line); } catch { continue; }
      for (const l of this.listeners) l(ev);
    }
  }

  async runPrompt(
    message: string,
    phaseLabel: string,
    timeoutMs: number,
    ctx: UiCtx,
    onTask?: (task: string) => void,
    onReview?: (r: ReviewCall) => void,
  ): Promise<PhaseResult> {
    if (this.closed) {
      return { tasks: [], reviews: [], timedOut: true, costUsd: 0 };
    }

    return new Promise<PhaseResult>((resolve) => {
      // Per-phase harvest state owned by the component parentSides.
      // Using their harvesters here (instead of the old inline name/
      // args switch) keeps the RPC event parsing in lockstep with the
      // single-shot delegate() path — any future stub-schema tweak in
      // a component file stays the one place that has to change.
      const dispatchState = RUN_DEFERRED_WRITER.initialState() as DispatchRequestsState;
      const reviewState = REVIEW.initialState() as ReviewState;
      const seenTasks = new Set<number>();
      const seenReviews = new Set<number>();
      let costUsd = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.listeners.delete(listener);
        resolve({
          tasks: dispatchState.tasks.slice(),
          reviews: reviewState.reviews.slice(),
          timedOut: true,
          costUsd,
        });
      }, timeoutMs);

      const listener = (ev: Record<string, unknown>) => {
        const type = ev.type as string | undefined;
        if (type === "message_end") {
          costUsd += extractCostUsd(ev);
        }
        if (type === "tool_execution_start") {
          RUN_DEFERRED_WRITER.harvest(ev, dispatchState);
          REVIEW.harvest(ev, reviewState);
          // Fire onTask / onReview for any newly-appended entries since
          // the last event so the parent's dashboard animates in real
          // time. (Component harvesters append in order; using the old
          // length as a cursor suffices.)
          while (seenTasks.size < dispatchState.tasks.length) {
            const idx = seenTasks.size;
            seenTasks.add(idx);
            if (onTask) onTask(dispatchState.tasks[idx]);
          }
          while (seenReviews.size < reviewState.reviews.length) {
            const idx = seenReviews.size;
            seenReviews.add(idx);
            if (onReview) onReview(reviewState.reviews[idx]);
          }
        } else if (type === "agent_end") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve({
            tasks: dispatchState.tasks.slice(),
            reviews: reviewState.reviews.slice(),
            timedOut: false,
            costUsd,
          });
        } else if (type === "response" && ev.success === false) {
          ctx.ui.notify(`${phaseLabel} RPC error: ${ev.error}`, "error");
        }
      };
      this.listeners.add(listener);

      try {
        this.child.stdin!.write(JSON.stringify({ type: "prompt", message }) + "\n");
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(listener);
        ctx.ui.notify(`${phaseLabel} failed to write prompt: ${(e as Error).message}`, "error");
        resolve({
          tasks: dispatchState.tasks.slice(),
          reviews: reviewState.reviews.slice(),
          timedOut: true,
          costUsd,
        });
      }
    });
  }

  close() {
    try { this.child.stdin!.end(); } catch {}
    try { this.child.kill("SIGKILL"); } catch {}
  }

  getStderrTail(bytes = 2000): string {
    return this.stderr.slice(-bytes);
  }
}

// Validation + sha256 + per-item sandbox checks live in
// stage-write.parentSide.finalize (phase 2.1); actual promotion goes
// through the exported `promote()` helper in ../lib/delegate.ts.

function renderWrittenSummary(promoted: TaskStagedWrite[]): string {
  const sections = promoted.map((p) => {
    const lines = p.content.split("\n");
    const shown = lines.slice(0, WRITTEN_PREVIEW_LINES).map((l) => trunc(l, WRITTEN_PREVIEW_CHARS));
    const more = lines.length > WRITTEN_PREVIEW_LINES ? `\n  … (+${lines.length - WRITTEN_PREVIEW_LINES} more lines)` : "";
    return `── ${p.relPath} (${p.byteLength} b) ──\n${shown.map((l) => "  " + l).join("\n")}${more}`;
  });
  return `Wrote ${promoted.length} file(s):\n\n${sections.join("\n\n")}`;
}

function buildReviewPrompt(
  tasks: string[],
  staged: TaskStagedWrite[],
  isInitial: boolean,
): string {
  const header = isInitial
    ? `All drafters have finished. Review every staged file by calling review(file_path, verdict, feedback).`
    : `Drafters re-ran with your feedback. Review the updated staged files again.`;
  const taskList = tasks.map((t, i) => `  [${i + 1}] ${t}`).join("\n");
  const files = staged.map((s) =>
    `--- ${s.relPath} (from subtask [${s.taskIndex + 1}]) ---\n${s.content}`
  ).join("\n\n");
  return `${header}

Rules:
- Emit exactly one review call per file listed below.
- verdict="approve" if the file meets the task and is correct.
- verdict="revise" if it needs another pass; feedback MUST be a sentence or two the drafter can act on.
- Do not invent paths — only review files listed.

Subtasks:
${taskList}

Staged files:
${files}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("delegated-writer", {
    description: "LLM delegator (single RPC session) with run_deferred_writer + review tools. No human confirm.",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /delegated-writer <user goal>", "error");
        return;
      }

      // The delegator RPC session needs $LEAD_MODEL directly;
      // drafter children pick up $TASK_MODEL through delegate()'s
      // tier inference since neither `review` nor `run-deferred-writer`
      // is declared on their component set.
      const LEAD_MODEL = process.env.LEAD_MODEL;
      if (!LEAD_MODEL) {
        ctx.ui.notify("LEAD_MODEL env var not set.", "error");
        return;
      }
      if (!process.env.TASK_MODEL) {
        ctx.ui.notify("TASK_MODEL env var not set (needed for drafter children).", "error");
        return;
      }

      const sandboxRoot = path.resolve(process.cwd());

      const state: PipelineState = {
        userGoal: args,
        phase: "dispatching",
        iteration: 0,
        drafters: new Map(),
        verdicts: new Map(),
        costs: { delegatorUsd: 0, draftersUsd: 0 },
      };
      const refreshUi = () => { updateDashboard(ctx, state); updateStatus(ctx, state); };
      refreshUi();

      const session = new DelegatorSession(LEAD_MODEL, sandboxRoot);

      try {
        // Phase 1: dispatch
        const dispatchPrompt = `You are a DELEGATOR. User goal: ${args}.

You have two tools:
- run_deferred_writer(task): dispatch one independent drafter child. Call once per subtask (1..${MAX_SUBTASKS}). Each "task" must be a complete, self-contained instruction a drafter can execute without further context. Drafters run in parallel; do not rely on ordering or shared state between them.
- review(file_path, verdict, feedback?): you will use this later once drafters finish; do NOT call it now.

In THIS turn, call run_deferred_writer once per subtask, then reply DONE and stop.`;

        const dispatchRes = await session.runPrompt(
          dispatchPrompt, "Dispatch", DELEGATOR_PHASE_TIMEOUT_MS, ctx,
          (task) => {
            const nextIdx = state.drafters.size;
            state.drafters.set(nextIdx, { task, phase: "pending", stagedWrites: [] });
            refreshUi();
          },
        );
        state.costs.delegatorUsd += dispatchRes.costUsd;
        refreshUi();
        if (dispatchRes.timedOut) {
          state.phase = "failed"; refreshUi();
          ctx.ui.notify(`Dispatch phase timed out. Stderr: ${session.getStderrTail()}`, "error");
          return;
        }
        if (dispatchRes.tasks.length === 0) {
          state.phase = "failed"; refreshUi();
          ctx.ui.notify("Delegator dispatched no tasks.", "error");
          return;
        }
        if (dispatchRes.tasks.length > MAX_SUBTASKS) {
          state.phase = "failed"; refreshUi();
          ctx.ui.notify(`Delegator exceeded MAX_SUBTASKS (${dispatchRes.tasks.length} > ${MAX_SUBTASKS}).`, "error");
          return;
        }
        const tasks = dispatchRes.tasks;

        // Phase 2: parallel drafters (initial). Each drafter goes through
        // delegate(autoPromote:false); validation + sha256 happens inside
        // stage-write.parentSide.finalize, so what we collect here are
        // already-checked StagedWritePlans.
        const taskPlans = new Map<number, StagedWritePlan[]>();
        const runAllDrafters = async (indices: number[], feedbackByTask?: Map<number, string[]>) => {
          state.phase = feedbackByTask ? "revising" : "drafting";
          for (const i of indices) {
            const d = state.drafters.get(i);
            if (d) { d.phase = "running"; d.stagedWrites = []; }
          }
          refreshUi();
          await Promise.all(indices.map(async (i) => {
            const fb = feedbackByTask?.get(i);
            const res = await runDrafter(
              tasks[i], fb, ctx,
              (w) => {
                const d = state.drafters.get(i);
                if (!d) return;
                d.stagedWrites.push(w);
                refreshUi();
              },
            );
            state.costs.draftersUsd += res.costUsd;
            const d = state.drafters.get(i);
            if (d) {
              if (res.timedOut) d.phase = "timed_out";
              else if (res.exitCode !== 0) d.phase = "error";
              else d.phase = "done";
            }
            refreshUi();
            taskPlans.set(i, res.plans);
          }));
        };
        await runAllDrafters(tasks.map((_, i) => i));

        // Phases 3+: review / revise loop
        let iteration = 0;
        let isInitial = true;
        while (true) {
          iteration++;
          if (iteration > MAX_REVISE_ITERATIONS) {
            ctx.ui.notify(`Hit MAX_REVISE_ITERATIONS (${MAX_REVISE_ITERATIONS}) — not all files approved. Nothing promoted.`, "error");
            return;
          }

          // Flatten drafter-produced plans into a cross-task list,
          // tagging each with its originating taskIndex for revise-loop
          // feedback attribution. Duplicate relPath across tasks is
          // skipped (first-writer-wins) — the review phase can't
          // disambiguate "two drafts for the same destination".
          const staged: TaskStagedWrite[] = [];
          const skips: string[] = [];
          const seenPaths = new Set<string>();
          for (const [taskIndex, plans] of taskPlans.entries()) {
            for (const plan of plans) {
              if (seenPaths.has(plan.relPath)) {
                skips.push(`${plan.relPath}: duplicate across tasks`);
                continue;
              }
              seenPaths.add(plan.relPath);
              staged.push({ ...plan, taskIndex });
            }
          }
          if (staged.length === 0) {
            state.phase = "failed"; refreshUi();
            ctx.ui.notify("No valid staged files after validation. Nothing to review.", "error");
            return;
          }
          if (staged.length > MAX_FILES_PROMOTABLE) {
            ctx.ui.notify(`Too many files (${staged.length} > ${MAX_FILES_PROMOTABLE}). Aborting.`, "error");
            return;
          }

          const reviewPrompt = buildReviewPrompt(tasks, staged, isInitial);
          isInitial = false;
          state.phase = "reviewing";
          state.iteration = iteration;
          state.verdicts.clear();
          refreshUi();

          const reviewRes = await session.runPrompt(
            reviewPrompt, `Review-${iteration}`, DELEGATOR_PHASE_TIMEOUT_MS, ctx,
            undefined,
            (r) => {
              state.verdicts.set(r.file_path, r);
              refreshUi();
            },
          );
          state.costs.delegatorUsd += reviewRes.costUsd;
          refreshUi();
          if (reviewRes.timedOut) {
            state.phase = "failed"; refreshUi();
            ctx.ui.notify(`Delegator review timed out. Stderr: ${session.getStderrTail()}`, "error");
            return;
          }

          // Build verdict map; missing verdicts → implicit revise.
          const verdictByPath = new Map<string, ReviewCall>();
          for (const r of reviewRes.reviews) verdictByPath.set(r.file_path, r);

          const approved: TaskStagedWrite[] = [];
          const feedbackByTask = new Map<number, string[]>();
          let anyRevise = false;
          for (const s of staged) {
            const v = verdictByPath.get(s.relPath);
            if (!v) {
              anyRevise = true;
              const arr = feedbackByTask.get(s.taskIndex) ?? [];
              arr.push(`${s.relPath}: Reviewer produced no verdict — reconsider the draft.`);
              feedbackByTask.set(s.taskIndex, arr);
              continue;
            }
            if (v.verdict === "revise") {
              anyRevise = true;
              const fb = v.feedback && v.feedback.trim()
                ? v.feedback.trim()
                : "Reviewer requested revision but provided no feedback.";
              const arr = feedbackByTask.get(s.taskIndex) ?? [];
              arr.push(`${s.relPath}: ${fb}`);
              feedbackByTask.set(s.taskIndex, arr);
            } else {
              approved.push(s);
            }
          }

          if (!anyRevise) {
            state.phase = "promoting";
            refreshUi();
            const { promoted, skips: promoteSkips } = promote(ctx, approved);
            if (promoteSkips.length > 0) {
              ctx.ui.notify(`Failures:\n${promoteSkips.join("\n")}`, "error");
            }
            const writtenSet = new Set(promoted);
            const written = approved.filter((p) => writtenSet.has(p.destAbs));
            state.phase = "done";
            refreshUi();
            if (written.length > 0) {
              const total = state.costs.delegatorUsd + state.costs.draftersUsd;
              const costLine = `Session cost: ${fmtUsd(total)} (delegator ${fmtUsd(state.costs.delegatorUsd)}, drafters ${fmtUsd(state.costs.draftersUsd)})`;
              ctx.ui.notify(`${renderWrittenSummary(written)}\n\n${costLine}`, "info");
            }
            return;
          }

          const revisedIndices = Array.from(feedbackByTask.keys());
          await runAllDrafters(revisedIndices, feedbackByTask);
        }
      } finally {
        const total = state.costs.delegatorUsd + state.costs.draftersUsd;
        if (state.phase !== "done" && total > 0) {
          ctx.ui.notify(
            `Session cost (no promotion): ${fmtUsd(total)} (delegator ${fmtUsd(state.costs.delegatorUsd)}, drafters ${fmtUsd(state.costs.draftersUsd)})`,
            "info",
          );
        }
        session.close();
        if (ctx.ui.setStatus) {
          try { ctx.ui.setStatus(DASHBOARD_KEY, undefined); } catch {}
        }
        clearDashboard(ctx);
      }
    },
  });
}
