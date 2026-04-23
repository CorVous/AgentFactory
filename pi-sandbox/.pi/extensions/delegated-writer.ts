import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DELEGATOR_PHASE_TIMEOUT_MS = 120_000;
const DRAFTER_TIMEOUT_MS = 180_000;
const MAX_SUBTASKS = 8;
const MAX_FILES_PROMOTABLE = 50;
const MAX_CONTENT_BYTES_PER_FILE = 2_000_000;
const MAX_REVISE_ITERATIONS = 3;
const NOTIFY_TEXT_MAX = 400;
const DASHBOARD_KEY = "delegated-writer";
const TASK_PREVIEW_CHARS = 60;
const CONTENT_PREVIEW_LINES = 2;
const CONTENT_PREVIEW_CHARS = 80;
const WRITTEN_PREVIEW_LINES = 8;
const WRITTEN_PREVIEW_CHARS = 120;

const STAGE_WRITE_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "stage-write.ts",
);
const RUN_DEFERRED_WRITER_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "run-deferred-writer.ts",
);
const REVIEW_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "review.ts",
);

type StagedWrite = {
  relPath: string;
  destAbs: string;
  content: string;
  sha: string;
  byteLength: number;
  taskIndex: number;
};

type ReviewCall = {
  file_path: string;
  verdict: "approve" | "revise";
  feedback?: string;
};

type DrafterResult = {
  stagedWrites: Array<{ path: unknown; content: unknown }>;
  code: number;
  timedOut: boolean;
  stderr: string;
  costUsd: number;
};

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

const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
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

// Drafter uses the classic non-RPC json mode — one-shot per task.
async function runDrafter(
  taskIndex: number,
  task: string,
  feedback: string[] | undefined,
  taskModel: string,
  sandboxRoot: string,
  ctx: UiCtx,
  onStage?: (w: { path: string; content: string; bytes: number }) => void,
): Promise<DrafterResult> {
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

  return new Promise((resolve) => {
    const child = spawn("pi", [
      "--mode", "json",
      "-e", STAGE_WRITE_TOOL,
      "-p", prompt,
      "--no-extensions", "--no-session", "--thinking", "off",
      "--tools", "stage_write,ls,read",
      "--provider", "openrouter", "--model", taskModel,
    ], { stdio: ["ignore", "pipe", "pipe"], cwd: sandboxRoot });

    let buffer = "";
    let stderr = "";
    const stagedWrites: Array<{ path: unknown; content: unknown }> = [];
    let costUsd = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, DRAFTER_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "tool_execution_start") {
          const name = e.toolName as string | undefined;
          const inputObj = e.args as Record<string, unknown> | undefined;
          if (name === "stage_write" && inputObj) {
            stagedWrites.push({ path: inputObj.path, content: inputObj.content });
            const p = typeof inputObj.path === "string" ? inputObj.path : "<?>";
            const content = typeof inputObj.content === "string" ? inputObj.content : "";
            if (onStage && typeof inputObj.path === "string") {
              onStage({ path: p, content, bytes: Buffer.byteLength(content, "utf8") });
            }
          }
        } else if (e.type === "message_end") {
          costUsd += extractCostUsd(e);
        }
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stagedWrites, code: code ?? 0, timedOut, stderr, costUsd });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stagedWrites, code: -1, timedOut, stderr, costUsd });
    });
  });
}

// Single persistent RPC-mode pi child, driven through multiple prompt/phase turns.
class DelegatorSession {
  private child: ChildProcess;
  private buffer = "";
  private stderr = "";
  private listeners = new Set<(ev: Record<string, unknown>) => void>();
  private closed = false;

  constructor(leadModel: string, sandboxRoot: string) {
    this.child = spawn("pi", [
      "--mode", "rpc",
      "--no-extensions", "--no-session", "--no-context-files",
      "--thinking", "off",
      "-e", RUN_DEFERRED_WRITER_TOOL,
      "-e", REVIEW_TOOL,
      "--tools", "run_deferred_writer,review",
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
      const tasks: string[] = [];
      const reviews: ReviewCall[] = [];
      let costUsd = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.listeners.delete(listener);
        resolve({ tasks, reviews, timedOut: true, costUsd });
      }, timeoutMs);

      const listener = (ev: Record<string, unknown>) => {
        const type = ev.type as string | undefined;
        if (type === "message_end") {
          costUsd += extractCostUsd(ev);
        }
        if (type === "tool_execution_start") {
          const name = ev.toolName as string | undefined;
          const inputObj = ev.args as Record<string, unknown> | undefined;
          if (name === "run_deferred_writer" && inputObj && typeof inputObj.task === "string") {
            tasks.push(inputObj.task);
            if (onTask) onTask(inputObj.task);
          } else if (name === "review" && inputObj && typeof inputObj.file_path === "string") {
            const verdict = inputObj.verdict === "approve" ? "approve" : "revise";
            const feedback = typeof inputObj.feedback === "string" ? inputObj.feedback : undefined;
            const rc: ReviewCall = { file_path: inputObj.file_path, verdict, feedback };
            reviews.push(rc);
            if (onReview) onReview(rc);
          }
        } else if (type === "agent_end") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve({ tasks, reviews, timedOut: false, costUsd });
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
        resolve({ tasks, reviews, timedOut: true, costUsd });
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

function validateStagedWrite(
  s: { path: unknown; content: unknown },
  taskIndex: number,
  sandboxRoot: string,
): StagedWrite | { error: string } {
  if (typeof s.path !== "string" || !s.path) return { error: "invalid path" };
  if (typeof s.content !== "string") return { error: `${s.path}: content not string` };
  const relPath = s.path;
  if (path.isAbsolute(relPath) || relPath.split("/").includes("..") || relPath.split(path.sep).includes("..")) {
    return { error: `${relPath}: absolute or contains '..'` };
  }
  const destAbs = path.resolve(sandboxRoot, relPath);
  if (destAbs !== sandboxRoot && !destAbs.startsWith(sandboxRoot + path.sep)) {
    return { error: `${relPath}: escapes sandbox` };
  }
  if (fs.existsSync(destAbs)) return { error: `${relPath}: destination exists` };
  const byteLength = Buffer.byteLength(s.content, "utf8");
  if (byteLength > MAX_CONTENT_BYTES_PER_FILE) {
    return { error: `${relPath}: too large (${byteLength} bytes)` };
  }
  return {
    relPath,
    destAbs,
    content: s.content,
    sha: sha256(s.content),
    byteLength,
    taskIndex,
  };
}

function promoteFiles(plans: StagedWrite[], ctx: UiCtx): StagedWrite[] {
  const promoted: StagedWrite[] = [];
  const failures: string[] = [];
  for (const p of plans) {
    try {
      if (fs.existsSync(p.destAbs)) { failures.push(`${p.relPath}: exists`); continue; }
      fs.mkdirSync(path.dirname(p.destAbs), { recursive: true });
      fs.writeFileSync(p.destAbs, p.content, "utf8");
      const actualSha = sha256(fs.readFileSync(p.destAbs, "utf8"));
      if (actualSha !== p.sha) { failures.push(`${p.relPath}: sha mismatch after write`); continue; }
      promoted.push(p);
    } catch (e) {
      failures.push(`${p.relPath}: ${(e as Error).message}`);
    }
  }
  if (failures.length > 0) ctx.ui.notify(`Failures:\n${failures.join("\n")}`, "error");
  return promoted;
}

function renderWrittenSummary(promoted: StagedWrite[]): string {
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
  staged: StagedWrite[],
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

      const LEAD_MODEL = process.env.LEAD_MODEL;
      const TASK_MODEL = process.env.TASK_MODEL;
      if (!LEAD_MODEL || !TASK_MODEL) {
        ctx.ui.notify("LEAD_MODEL or TASK_MODEL env var not set.", "error");
        return;
      }

      for (const t of [STAGE_WRITE_TOOL, RUN_DEFERRED_WRITER_TOOL, REVIEW_TOOL]) {
        if (!fs.existsSync(t)) {
          ctx.ui.notify(`Missing child-tool: ${t}`, "error");
          return;
        }
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

        // Phase 2: parallel drafters (initial)
        const taskStaged = new Map<number, Array<{ path: unknown; content: unknown }>>();
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
              i, tasks[i], fb, TASK_MODEL, sandboxRoot, ctx,
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
              else if (res.code !== 0) d.phase = "error";
              else d.phase = "done";
            }
            refreshUi();
            taskStaged.set(i, res.stagedWrites);
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

          const staged: StagedWrite[] = [];
          const skips: string[] = [];
          const seenPaths = new Set<string>();
          for (const [taskIndex, writes] of taskStaged.entries()) {
            for (const w of writes) {
              if (typeof w.path === "string" && seenPaths.has(w.path)) {
                skips.push(`${w.path}: duplicate across tasks`);
                continue;
              }
              const result = validateStagedWrite(w, taskIndex, sandboxRoot);
              if ("error" in result) { skips.push(result.error); continue; }
              seenPaths.add(result.relPath);
              staged.push(result);
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

          const approved: StagedWrite[] = [];
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
            const written = promoteFiles(approved, ctx);
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
