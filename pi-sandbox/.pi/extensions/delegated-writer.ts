import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DELEGATOR_TIMEOUT_MS = 60_000;
const DRAFTER_TIMEOUT_MS = 180_000;
const REVIEWER_TIMEOUT_MS = 120_000;
const MAX_SUBTASKS = 8;
const MAX_FILES_PROMOTABLE = 50;
const MAX_REVISE_ITERATIONS = 3;
const MAX_CONTENT_BYTES_PER_FILE = 2_000_000;
const PREVIEW_LINES_PER_FILE = 20;
const NOTIFY_TEXT_MAX = 400;

const STAGE_WRITE_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "child-tools",
  "stage-write.ts",
);

const RUN_DEFERRED_WRITER_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "child-tools",
  "run-deferred-writer.ts",
);

const REVIEW_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "child-tools",
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

type ChildResult = {
  assistantText: string;
  assistantThinking: string;
  toolCalls: number;
  stagedWrites: Array<{ path: string; content: string }>;
  tasks: string[];
  reviews: Array<{ file_path: string; verdict: "approve" | "revise"; feedback?: string }>;
  stderr: string;
  code: number;
  timedOut: boolean;
};

export default function (pi: ExtensionAPI) {
  const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
  const trunc = (s: string, n = NOTIFY_TEXT_MAX) =>
    s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;

  async function runChild(
    phaseLabel: string,
    args: string[],
    ctx: { ui: { notify: (m: string, level: "info" | "warning" | "error") => void } },
    timeoutMs: number,
    cwd: string = process.cwd(),
  ): Promise<ChildResult> {
    return new Promise((resolve) => {
      const fullArgs = ["--mode", "json", ...args];
      const child = spawn("pi", fullArgs, { stdio: ["ignore", "pipe", "pipe"], cwd });
      let buffer = "";
      let stderr = "";
      let assistantText = "";
      let assistantThinking = "";
      let toolCalls = 0;
      const stagedWrites: Array<{ path: string; content: string }> = [];
      const tasks: string[] = [];
      const reviews: Array<{ file_path: string; verdict: "approve" | "revise"; feedback?: string }> = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (d) => {
        buffer += d.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let e: Record<string, any>;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (e.type === "tool_execution_start") {
            toolCalls++;
            const name = e.toolName;
            const inputObj = e.args;
            if (name === "stage_write" && inputObj) {
              stagedWrites.push({ path: inputObj.path, content: inputObj.content });
              ctx.ui.notify(`${phaseLabel} → stage_write ${inputObj.path} (${inputObj.content?.length ?? 0} chars)`, "info");
            } else if (name === "run_deferred_writer" && inputObj) {
              tasks.push(inputObj.task);
              ctx.ui.notify(`${phaseLabel} → dispatched task: ${trunc(inputObj.task, 80)}`, "info");
            } else if (name === "review" && inputObj) {
              reviews.push({ file_path: inputObj.file_path, verdict: inputObj.verdict, feedback: inputObj.feedback });
              ctx.ui.notify(`${phaseLabel} → review ${inputObj.file_path}: ${inputObj.verdict}`, "info");
            } else {
              ctx.ui.notify(`${phaseLabel} → ${name}`, "info");
            }
          } else if (e.type === "message_end") {
            const msg = e.message;
            if (msg?.role === "assistant" && Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === "text") assistantText += part.text;
                if (part.type === "thinking") assistantThinking += part.thinking;
              }
            }
          }
        }
      });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ assistantText, assistantThinking, toolCalls, stagedWrites, tasks, reviews, stderr, code: code ?? 0, timedOut });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ assistantText, assistantThinking, toolCalls, stagedWrites, tasks, reviews, stderr, code: -1, timedOut });
      });
    });
  }

  pi.registerCommand("delegated-writer", {
    description: "LLM delegator that dispatches subtasks to parallel drafters",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /delegated-writer <user goal>", "warning");
        return;
      }

      const LEAD_MODEL = process.env.LEAD_MODEL;
      const TASK_MODEL = process.env.TASK_MODEL;
      if (!LEAD_MODEL || !TASK_MODEL) {
        ctx.ui.notify("LEAD_MODEL or TASK_MODEL env var not set.", "error");
        return;
      }

      const sandboxRoot = path.resolve(process.cwd());

      // Phase 1: Delegation
      ctx.ui.notify(`Delegating (model=${LEAD_MODEL}, timeout=${DELEGATOR_TIMEOUT_MS/1000}s)...`, "info");
      const delegatorPrompt = `You are a DELEGATOR. User goal: ${args}.
Your ONLY capability is to call 'run_deferred_writer(task)' for each subtask.
Each call dispatches one independent drafter.
Decide how many subtasks (1-${MAX_SUBTASKS}) and what to tell each.
The 'task' string must be a complete self-contained instruction a drafter can execute without further context.
Stop once you have dispatched all subtasks.`;

      const delegatorRes = await runChild(
        "Delegator",
        [
          "-e", RUN_DEFERRED_WRITER_TOOL,
          "-p", delegatorPrompt,
          "--no-extensions", "--no-session", "--thinking", "off", "--mode", "json",
          "--tools", "run_deferred_writer",
          "--provider", "openrouter", "--model", LEAD_MODEL,
        ],
        ctx,
        DELEGATOR_TIMEOUT_MS,
        sandboxRoot,
      );

      if (delegatorRes.timedOut) {
        ctx.ui.notify(`Delegator timed out.`, "error");
        return;
      }
      if (delegatorRes.tasks.length === 0) {
        ctx.ui.notify("Delegator dispatched no tasks.", "warning");
        return;
      }
      if (delegatorRes.tasks.length > MAX_SUBTASKS) {
        ctx.ui.notify(`Delegator exceeded max tasks (${delegatorRes.tasks.length} > ${MAX_SUBTASKS}). Aborting.`, "error");
        return;
      }

      ctx.ui.notify(`Dispatched ${delegatorRes.tasks.length} tasks. Running drafters in parallel...`, "info");

      // Phase 2: Parallel Drafting
      ctx.ui.notify(`Running ${delegatorRes.tasks.length} drafters in parallel (model=${TASK_MODEL}, timeout=${DRAFTER_TIMEOUT_MS/1000}s)...`, "info");
      
      const taskStagedWrites: Map<number, Array<{ path: string; content: string }>> = new Map();

      async function runDrafter(task: string, index: number, feedback?: string[]) {
        const drafterPrompt = feedback 
          ? `You are a DRAFTER. This is a REVISION attempt for the task: ${task}.
The following feedback was provided for your previous attempt:
${feedback.map(f => `- ${f}`).join("\n")}

Nothing you do will touch disk until the user approves. To create a file, call 'stage_write' with a relative 'path' and full 'content'.
Rules:
- Only use 'stage_write'. No real write tools.
- Paths must be relative, inside ${sandboxRoot}, no '..'.
- Use 'read'/'ls' on absolute paths under ${sandboxRoot} to explore.
- Stop after staging all needed files.`
          : `You are a DRAFTER. Task: ${task}.
Nothing you do will touch disk until the user approves. To create a file, call 'stage_write' with a relative 'path' and full 'content'.
Rules:
- Only use 'stage_write'. No real write tools.
- Paths must be relative, inside ${sandboxRoot}, no '..'.
- Use 'read'/'ls' on absolute paths under ${sandboxRoot} to explore.
- Stop after staging all needed files.`;

        const res = await runChild(
          `Drafter-${index + 1}`,
          [
            "-e", STAGE_WRITE_TOOL,
            "-p", drafterPrompt,
            "--no-extensions", "--no-session", "--thinking", "off", "--mode", "json",
            "--tools", "stage_write,ls,read",
            "--provider", "openrouter", "--model", TASK_MODEL!,
          ],
          ctx,
          DRAFTER_TIMEOUT_MS,
          sandboxRoot,
        );
        if (res.timedOut) ctx.ui.notify(`Drafter-${index + 1} timed out.`, "warning");
        taskStagedWrites.set(index, res.stagedWrites);
      }

      await Promise.all(delegatorRes.tasks.map((task, i) => runDrafter(task, i)));

      // Phase 3 & 4: Review and Revise Loop
      let iteration = 0;
      while (iteration < MAX_REVISE_ITERATIONS) {
        iteration++;
        ctx.ui.notify(`Review phase (iteration ${iteration}/${MAX_REVISE_ITERATIONS}, model=${LEAD_MODEL}, timeout=${REVIEWER_TIMEOUT_MS/1000}s)...`, "info");

        const allStagedCurrent: StagedWrite[] = [];
        const seenPaths = new Set<string>();

        for (const [taskIndex, writes] of taskStagedWrites.entries()) {
          for (const s of writes) {
            if (typeof s.path !== "string" || !s.path || typeof s.content !== "string") continue;
            if (seenPaths.has(s.path)) {
              ctx.ui.notify(`Duplicate path ${s.path} across tasks. Ignoring.`, "warning");
              continue;
            }
            seenPaths.add(s.path);
            
            const relPath = s.path;
            if (path.isAbsolute(relPath) || relPath.split("/").includes("..") || relPath.split(path.sep).includes("..")) continue;
            const destAbs = path.resolve(sandboxRoot, relPath);
            if (!destAbs.startsWith(sandboxRoot + path.sep) && destAbs !== sandboxRoot) continue;
            if (fs.existsSync(destAbs)) continue;
            const byteLength = Buffer.byteLength(s.content, "utf8");
            if (byteLength > MAX_CONTENT_BYTES_PER_FILE) continue;

            allStagedCurrent.push({
              relPath,
              destAbs,
              content: s.content,
              sha: sha256(s.content),
              byteLength,
              taskIndex,
            });
          }
        }

        if (allStagedCurrent.length === 0) {
          ctx.ui.notify("No valid files staged to review.", "warning");
          return;
        }
        if (allStagedCurrent.length > MAX_FILES_PROMOTABLE) {
          ctx.ui.notify(`Too many files staged (${allStagedCurrent.length} > ${MAX_FILES_PROMOTABLE}). Aborting.`, "error");
          return;
        }

        let reviewPrompt = `You are a REVIEWER. For each staged file below, call \`review(file_path, verdict, feedback)\`:
- verdict="approve" if the file meets the task and is correct.
- verdict="revise" with feedback (a sentence or two the drafter can act on) if it needs another pass.

Do NOT invent paths — only review files listed. You MUST emit exactly one review call per file.

Subtasks:
${delegatorRes.tasks.map((t, i) => `  [${i + 1}] ${t}`).join("\n")}

Staged files:
`;

        for (const s of allStagedCurrent) {
          reviewPrompt += `--- ${s.relPath} (from subtask [${s.taskIndex + 1}]) ---\n${s.content}\n`;
        }

        const reviewRes = await runChild(
          "Reviewer",
          [
            "-e", REVIEW_TOOL,
            "-p", reviewPrompt,
            "--no-extensions", "--no-session", "--thinking", "off", "--mode", "json",
            "--tools", "review",
            "--provider", "openrouter", "--model", LEAD_MODEL,
          ],
          ctx,
          REVIEWER_TIMEOUT_MS,
          sandboxRoot,
        );

        if (reviewRes.timedOut) {
          ctx.ui.notify(`Reviewer timed out.`, "error");
          return;
        }

        const verdictsMap = new Map<string, { verdict: "approve" | "revise"; feedback: string }>();
        for (const r of reviewRes.reviews) {
          verdictsMap.set(r.file_path, { verdict: r.verdict, feedback: r.feedback || "" });
        }

        const revisedTasksMap: Map<number, string[]> = new Map();
        const approvedFiles: StagedWrite[] = [];
        let anyRevision = false;

        for (const s of allStagedCurrent) {
          let v = verdictsMap.get(s.relPath);
          if (!v) {
            ctx.ui.notify(`Reviewer produced no verdict for ${s.relPath}. Treating as revise.`, "warning");
            v = { verdict: "revise", feedback: "Reviewer produced no verdict." };
          }
          if (v.verdict === "revise" && !v.feedback) {
            ctx.ui.notify(`Reviewer gave 'revise' for ${s.relPath} without feedback.`, "warning");
            v.feedback = "Reviewer requested revision but provided no feedback.";
          }

          if (v.verdict === "revise") {
            anyRevision = true;
            const taskFeedback = revisedTasksMap.get(s.taskIndex) ?? [];
            taskFeedback.push(`${s.relPath}: ${v.feedback}`);
            revisedTasksMap.set(s.taskIndex, taskFeedback);
          } else {
            approvedFiles.push(s);
          }
        }

        if (!anyRevision) {
          // All approved!
          await promoteFiles(approvedFiles, ctx);
          return;
        }

        // Run revisions
        const revisionIndices = Array.from(revisedTasksMap.keys());
        ctx.ui.notify(`Revision needed for ${revisionIndices.length} tasks. Re-drafting...`, "info");
        await Promise.all(revisionIndices.map(idx => runDrafter(delegatorRes.tasks[idx], idx, revisedTasksMap.get(idx))));
      }

      ctx.ui.notify(`Max revision iterations (${MAX_REVISE_ITERATIONS}) reached. Aborting.`, "error");
    }
  });

  async function promoteFiles(plans: StagedWrite[], ctx: any) {
    const promoted: string[] = [];
    const failures: string[] = [];
    for (const p of plans) {
      try {
        if (fs.existsSync(p.destAbs)) {
          failures.push(`${p.relPath}: exists`);
          continue;
        }
        fs.mkdirSync(path.dirname(p.destAbs), { recursive: true });
        fs.writeFileSync(p.destAbs, p.content, "utf8");
        const actualSha = createHash("sha256").update(fs.readFileSync(p.destAbs, "utf8"), "utf8").digest("hex");
        if (actualSha !== p.sha) {
          failures.push(`${p.relPath}: SHA mismatch after write`);
          continue;
        }
        promoted.push(p.relPath);
      } catch (e) {
        failures.push(`${p.relPath}: ${(e as Error).message}`);
      }
    }

    if (failures.length > 0) ctx.ui.notify(`Failures:\n${failures.join("\n")}`, "error");
    if (promoted.length > 0) ctx.ui.notify(`Wrote ${promoted.length} files:\n${promoted.join("\n")}`, "info");
  }
}
