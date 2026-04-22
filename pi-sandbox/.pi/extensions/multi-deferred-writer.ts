import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 180_000;
const REVIEW_TIMEOUT_MS = 60_000;
const PLAN_TIMEOUT_MS = 60_000;
const NOTIFY_TEXT_MAX = 400;
const PREVIEW_LINES_PER_FILE = 20;
const MAX_FILES_PROMOTABLE = 100;
const MAX_CONTENT_BYTES_PER_FILE = 2_000_000;

const STAGE_WRITE_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "child-tools",
  "stage-write.ts",
);

type StagedWrite = {
  relPath: string;
  destAbs: string;
  content: string;
  sha: string;
  byteLength: number;
  sourceTask: string;
};

type ChildResult = {
  assistantText: string;
  assistantThinking: string;
  toolCalls: number;
  stagedWrites: Array<{ path: unknown; content: unknown }>;
  stderr: string;
  code: number;
  timedOut: boolean;
};

type ReviewResult = {
  approved: boolean;
  reason: string;
};

export default function (pi: ExtensionAPI) {

  async function runChild(
    phaseLabel: string,
    args: string[],
    ctx: { ui: { notify: (m: string, level: "info" | "warning" | "error") => void } },
    timeoutMs = PHASE_TIMEOUT_MS,
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
      const stagedWrites: Array<{ path: unknown; content: unknown }> = [];
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
          let e: Record<string, unknown>;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          const type = e.type as string | undefined;
          if (type === "tool_execution_start") {
            toolCalls++;
            const name = (e.toolName as string | undefined) ?? "?";
            const inputObj = e.args as Record<string, unknown> | undefined;
            if (name === "stage_write" && inputObj) {
              stagedWrites.push({ path: inputObj.path, content: inputObj.content });
              const p = typeof inputObj.path === "string" ? inputObj.path : "<?>";
              const len = typeof inputObj.content === "string" ? inputObj.content.length : 0;
              ctx.ui.notify(`${phaseLabel} → stage_write ${p} (${len} chars buffered)`, "info");
            } else {
              const inputPreview = inputObj ? JSON.stringify(inputObj).slice(0, 120) : "";
              ctx.ui.notify(`${phaseLabel} → ${name}${inputPreview ? " " + inputPreview : ""}`, "info");
            }
          } else if (type === "message_end") {
            const msg = e.message as { role?: string; content?: unknown } | undefined;
            if (msg?.role === "assistant" && Array.isArray(msg.content)) {
              let text = "";
              let thinking = "";
              for (const part of msg.content as Array<{ type?: string; text?: string; thinking?: string }>) {
                if (part?.type === "text" && typeof part.text === "string") text += part.text;
                if (part?.type === "thinking" && typeof part.thinking === "string") thinking += part.thinking;
              }
              if (text) assistantText = text;
              if (thinking) assistantThinking = thinking;
            }
          }
        }
      });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ assistantText, assistantThinking, toolCalls, stagedWrites, stderr, code: code ?? 0, timedOut });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ assistantText, assistantThinking, toolCalls, stagedWrites, stderr, code: -1, timedOut });
      });
    });
  }

  const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");

  const trunc = (s: string, n = NOTIFY_TEXT_MAX) =>
    s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;

  async function reviewWrite(
    write: StagedWrite,
    criteria: string,
    leadModel: string,
    ctx: { ui: { notify: (m: string, level: "info" | "warning" | "error") => void } }
  ): Promise<ReviewResult> {
    const prompt = `You are a SUBTASK REVIEWER. 
Acceptance Criteria: ${criteria}

Action being reviewed: Stage write of "${write.relPath}"
Content:
---
${write.content}
---

Task that produced this: ${write.sourceTask}

Evaluate if this write meets the criteria. 
Respond with exactly one JSON object:
{"approved": boolean, "reason": "string"}

Do not include any other text.`;

    const res = await runChild(
      `Reviewer(${write.relPath})`,
      [
        "-p", prompt,
        "--no-extensions",
        "--tools", "ls,read",
        "--provider", "openrouter",
        "--model", leadModel,
        "--thinking", "off",
        "--no-session",
      ],
      ctx,
      REVIEW_TIMEOUT_MS
    );

    if (res.timedOut) return { approved: false, reason: "Reviewer timed out." };
    if (res.code !== 0) return { approved: false, reason: `Reviewer failed (exit ${res.code}): ${res.stderr.slice(-200)}` };

    try {
      // Find JSON block in assistantText
      const match = res.assistantText.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON object found in reviewer response");
      const json = JSON.parse(match[0]);
      if (typeof json.approved !== "boolean" || typeof json.reason !== "string") {
        throw new Error("Invalid structure in reviewer response");
      }
      return json as ReviewResult;
    } catch (e) {
      return { approved: false, reason: `Failed to parse reviewer verdict: ${(e as Error).message}` };
    }
  }

  pi.registerCommand("multi-deferred-writer", {
    description: "Orchestrate multiple parallel drafters and a reviewer based on a single prompt.",
    handler: async (args, ctx) => {
      const userPrompt = args.trim();
      if (!userPrompt) {
        ctx.ui.notify("Usage: /multi-deferred-writer <prompt>", "warning");
        return;
      }

      const PLAN_MODEL = process.env.PLAN_MODEL;
      const TASK_MODEL = process.env.TASK_MODEL;
      const LEAD_MODEL = process.env.LEAD_MODEL;
      if (!PLAN_MODEL) {
        ctx.ui.notify("PLAN_MODEL env var not set.", "error");
        return;
      }
      if (!TASK_MODEL || !LEAD_MODEL) {
        ctx.ui.notify("TASK_MODEL or LEAD_MODEL env var not set.", "error");
        return;
      }

      const plannerPrompt = `You are a PROJECT PLANNER. 
User Goal: ${userPrompt}

Decompose this goal into 1 to 8 independent subtasks. 
Each subtask should be a self-contained drafting task for one or more files.
Subtasks will be executed in parallel with NO shared state. 
They must collectively cover the entire user goal.

Return exactly one JSON object with this structure:
{
  "criteria": "string — acceptance criteria the reviewer will check each file against",
  "subtasks": ["string — subtask 1", "string — subtask 2", ...]
}

No prose outside the JSON.`;

      ctx.ui.notify(`Decomposing task with ${PLAN_MODEL}...`, "info");
      const planRes = await runChild(
        "Planner",
        [
          "-p", plannerPrompt,
          "--no-tools",
          "--no-extensions",
          "--no-session",
          "--provider", "openrouter",
          "--model", PLAN_MODEL,
          "--thinking", "off",
        ],
        ctx,
        PLAN_TIMEOUT_MS
      );

      if (planRes.timedOut) {
        ctx.ui.notify("Planner timed out.", "error");
        return;
      }
      if (planRes.code !== 0) {
        ctx.ui.notify(`Planner failed (exit ${planRes.code}): ${planRes.stderr.slice(-200)}`, "error");
        return;
      }

      let plan: { criteria: string; subtasks: string[] };
      try {
        const match = planRes.assistantText.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON object found in planner response");
        plan = JSON.parse(match[0]);
        if (!plan.criteria || !Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
          throw new Error("Invalid plan structure (missing criteria or subtasks)");
        }
        if (plan.subtasks.length > 8) {
          throw new Error(`Too many subtasks (${plan.subtasks.length} > 8)`);
        }
      } catch (e) {
        ctx.ui.notify(`Planning failed: ${(e as Error).message}`, "error");
        return;
      }

      const criteria = plan.criteria;
      const subtasks = plan.subtasks;

      ctx.ui.notify(`Plan Created:
Criteria: ${criteria}
Tasks:
${subtasks.map((s, i) => `${i + 1}. ${s}`).join("\n")}`, "info");

      if (!fs.existsSync(STAGE_WRITE_TOOL)) {
        ctx.ui.notify(`stage_write tool missing at ${STAGE_WRITE_TOOL}`, "error");
        return;
      }

      const sandboxRoot = path.resolve(process.cwd());
      ctx.ui.notify(`Starting ${subtasks.length} drafters (Task Model: ${TASK_MODEL})...`, "info");

      const drafterPromises = subtasks.map(async (task, idx) => {
        const label = `Drafter-${idx + 1}`;
        const agentPrompt = `You are a DRAFTER for a specific subtask.
Overall Task Context: ${userPrompt}
Your Specific Subtask: ${task}

Nothing you do will touch disk until the user and a reviewer approve. To create a file, call the \`stage_write\` tool with a relative \`path\` (inside the project at ${sandboxRoot}) and the full \`content\`.

Rules:
- Do NOT call any \`write\` tool — only \`stage_write\`.
- Paths must be relative, inside ${sandboxRoot}, no \`..\` segments.
- To inspect the existing project, use \`read\` / \`ls\` on ABSOLUTE paths under ${sandboxRoot}.
- Stop after you've staged everything the task needs. Reply DONE and stop.`;

        const res = await runChild(
          label,
          [
            "-e", STAGE_WRITE_TOOL,
            "-p", agentPrompt,
            "--no-extensions",
            "--tools", "stage_write,ls,read",
            "--provider", "openrouter",
            "--model", TASK_MODEL,
            "--thinking", "off",
            "--no-session",
          ],
          ctx,
          PHASE_TIMEOUT_MS,
          sandboxRoot,
        );
        return { task, res, label };
      });

      const drafterResults = await Promise.all(drafterPromises);

      const allStaged: StagedWrite[] = [];
      const skips: string[] = [];

      for (const { task, res, label } of drafterResults) {
        if (res.timedOut) {
            ctx.ui.notify(`${label} timed out.`, "error");
            continue;
        }
        if (res.code !== 0) {
            ctx.ui.notify(`${label} exited ${res.code}. Stderr: ${res.stderr.slice(-500)}`, "error");
            continue;
        }

        for (const s of res.stagedWrites) {
          if (typeof s.path !== "string" || s.path.length === 0) {
            skips.push(`${label}: invalid path type`);
            continue;
          }
          if (typeof s.content !== "string") {
            skips.push(`${label}: ${s.path} content is not string`);
            continue;
          }
          const relPath = s.path;
          if (path.isAbsolute(relPath) || relPath.split("/").includes("..") || relPath.split(path.sep).includes("..")) {
            skips.push(`${label}: ${relPath} is absolute or contains '..'`);
            continue;
          }
          const destAbs = path.resolve(sandboxRoot, relPath);
          if (destAbs !== sandboxRoot && !destAbs.startsWith(sandboxRoot + path.sep)) {
            skips.push(`${label}: ${relPath} escapes sandbox`);
            continue;
          }
          if (fs.existsSync(destAbs)) {
            skips.push(`${label}: ${relPath} already exists on disk`);
            continue;
          }
          const byteLength = Buffer.byteLength(s.content, "utf8");
          if (byteLength > MAX_CONTENT_BYTES_PER_FILE) {
            skips.push(`${label}: ${relPath} too large (${byteLength} bytes)`);
            continue;
          }

          allStaged.push({
            relPath,
            destAbs,
            content: s.content,
            sha: sha256(s.content),
            byteLength,
            sourceTask: task
          });
        }
      }

      for (const skip of skips) ctx.ui.notify(`Skipping draft: ${skip}`, "warning");

      if (allStaged.length === 0) {
        ctx.ui.notify("No valid drafts produced by any drafter.", "warning");
        return;
      }

      if (allStaged.length > MAX_FILES_PROMOTABLE) {
        ctx.ui.notify(`Too many drafts (${allStaged.length} > ${MAX_FILES_PROMOTABLE}). Aborting.`, "error");
        return;
      }

      // De-duplicate by relPath. If multiple drafters wrote to the same path, first one wins for now
      // (or we could show it as a conflict, but the prompt doesn't specify conflict resolution).
      const finalWrites = new Map<string, StagedWrite>();
      for (const w of allStaged) {
        if (!finalWrites.has(w.relPath)) {
          finalWrites.set(w.relPath, w);
        } else {
            ctx.ui.notify(`Conflict: multiple drafters touched ${w.relPath}. Keeping first one reached.`, "warning");
        }
      }

      const writesToReview = Array.from(finalWrites.values());
      ctx.ui.notify(`Reviewing ${writesToReview.length} files with ${LEAD_MODEL}...`, "info");

      const reviews = await Promise.all(
        writesToReview.map(w => reviewWrite(w, criteria, LEAD_MODEL, ctx))
      );

      const approved: StagedWrite[] = [];
      const rejectedDetails: string[] = [];

      for (let i = 0; i < writesToReview.length; i++) {
        const w = writesToReview[i];
        const r = reviews[i];
        if (r.approved) {
          approved.push(w);
          ctx.ui.notify(`✅ Approved: ${w.relPath}`, "info");
        } else {
          rejectedDetails.push(`❌ Rejected: ${w.relPath}\nReason: ${r.reason}`);
          ctx.ui.notify(`❌ Rejected: ${w.relPath}`, "warning");
        }
      }

      if (rejectedDetails.length > 0) {
        ctx.ui.notify(`Rejection details:\n${rejectedDetails.join("\n")}`, "warning");
      }

      if (approved.length === 0) {
        ctx.ui.notify("No files were approved. Ending.", "warning");
        return;
      }

      const previewSections = approved.map((p) => {
        const header = `${p.destAbs} (${p.byteLength} bytes, sha ${p.sha.slice(0, 10)}…)`;
        const lines = p.content.split("\n");
        const shown = lines.slice(0, PREVIEW_LINES_PER_FILE).join("\n");
        const tail = lines.length > PREVIEW_LINES_PER_FILE
          ? `\n… (+${lines.length - PREVIEW_LINES_PER_FILE} more lines)`
          : "";
        return `${header}\n${shown}${tail}`;
      });
      const previewBody = previewSections.join("\n\n---\n\n");

      const ok = await ctx.ui.confirm(
        `Promote ${approved.length} approved file(s)?`,
        previewBody,
      );

      if (!ok) {
        ctx.ui.notify("Cancelled; nothing written.", "info");
        return;
      }

      const promoted: string[] = [];
      const failures: string[] = [];
      for (const p of approved) {
        if (fs.existsSync(p.destAbs)) {
          failures.push(`${p.relPath}: destination now exists`);
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(p.destAbs), { recursive: true });
          fs.writeFileSync(p.destAbs, p.content, "utf8");
          const actualSha = sha256(fs.readFileSync(p.destAbs, "utf8"));
          if (actualSha !== p.sha) {
            failures.push(`${p.relPath}: hash mismatch after write`);
            continue;
          }
          promoted.push(p.destAbs);
        } catch (e) {
          failures.push(`${p.relPath}: ${(e as Error).message}`);
        }
      }

      if (failures.length > 0) {
        ctx.ui.notify(`Promotion failures:\n${failures.join("\n")}`, "error");
      }
      if (promoted.length > 0) {
        ctx.ui.notify(`Successfully wrote ${promoted.length} file(s).`, "info");
      }
    }
  });
}
