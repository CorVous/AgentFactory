import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DELEGATOR_TIMEOUT_MS = 60_000;
const DRAFTER_TIMEOUT_MS = 180_000;
const MAX_SUBTASKS = 8;
const MAX_FILES_PROMOTABLE = 50;
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

type StagedWrite = {
  relPath: string;
  destAbs: string;
  content: string;
  sha: string;
  byteLength: number;
};

type ChildResult = {
  assistantText: string;
  assistantThinking: string;
  toolCalls: number;
  stagedWrites: Array<{ path: string; content: string }>;
  tasks: string[];
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
        resolve({ assistantText, assistantThinking, toolCalls, stagedWrites, tasks, stderr, code: code ?? 0, timedOut });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ assistantText, assistantThinking, toolCalls, stagedWrites, tasks, stderr, code: -1, timedOut });
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
      const drafterPromises = delegatorRes.tasks.map((task, i) => {
        const drafterPrompt = `You are a DRAFTER. Task: ${task}.
Nothing you do will touch disk until the user approves. To create a file, call 'stage_write' with a relative 'path' and full 'content'.
Rules:
- Only use 'stage_write'. No real write tools.
- Paths must be relative, inside ${sandboxRoot}, no '..'.
- Use 'read'/'ls' on absolute paths under ${sandboxRoot} to explore.
- Stop after staging all needed files.`;

        return runChild(
          `Drafter-${i+1}`,
          [
            "-e", STAGE_WRITE_TOOL,
            "-p", drafterPrompt,
            "--no-extensions", "--no-session", "--thinking", "off", "--mode", "json",
            "--tools", "stage_write,ls,read",
            "--provider", "openrouter", "--model", TASK_MODEL,
          ],
          ctx,
          DRAFTER_TIMEOUT_MS,
          sandboxRoot,
        );
      });

      const drafterResults = await Promise.all(drafterPromises);
      
      const allStaged: Array<{ path: string; content: string }> = [];
      for (const res of drafterResults) {
        if (res.timedOut) ctx.ui.notify(`A drafter timed out. Partial results may be present.`, "warning");
        allStaged.push(...res.stagedWrites);
      }

      if (allStaged.length === 0) {
        ctx.ui.notify("No files were staged by any drafter.", "warning");
        return;
      }
      if (allStaged.length > MAX_FILES_PROMOTABLE) {
        ctx.ui.notify(`Too many files staged (${allStaged.length} > ${MAX_FILES_PROMOTABLE}). Aborting.`, "error");
        return;
      }

      // Phase 3: Validation and Promotion
      const plans: StagedWrite[] = [];
      const skips: string[] = [];
      const seenPaths = new Set<string>();

      for (const s of allStaged) {
        if (typeof s.path !== "string" || !s.path) {
          skips.push(`<invalid path>`);
          continue;
        }
        if (typeof s.content !== "string") {
          skips.push(`${s.path}: content not string`);
          continue;
        }
        if (seenPaths.has(s.path)) {
          skips.push(`${s.path}: duplicate path across drafters`);
          continue;
        }
        seenPaths.add(s.path);

        const relPath = s.path;
        if (path.isAbsolute(relPath) || relPath.split("/").includes("..") || relPath.split(path.sep).includes("..")) {
          skips.push(`${relPath}: absolute or contains '..'`);
          continue;
        }
        const destAbs = path.resolve(sandboxRoot, relPath);
        if (!destAbs.startsWith(sandboxRoot + path.sep) && destAbs !== sandboxRoot) {
          skips.push(`${relPath}: escapes sandbox`);
          continue;
        }
        if (fs.existsSync(destAbs)) {
          skips.push(`${relPath}: destination exists`);
          continue;
        }
        const byteLength = Buffer.byteLength(s.content, "utf8");
        if (byteLength > MAX_CONTENT_BYTES_PER_FILE) {
          skips.push(`${relPath}: too large (${byteLength} bytes)`);
          continue;
        }

        plans.push({
          relPath,
          destAbs,
          content: s.content,
          sha: sha256(s.content),
          byteLength,
        });
      }

      for (const skip of skips) ctx.ui.notify(`Skipping ${skip}`, "warning");

      if (plans.length === 0) {
        ctx.ui.notify("No promotable drafts remaining.", "warning");
        return;
      }

      const previewBody = plans.map(p => {
        const lines = p.content.split("\n");
        const shown = lines.slice(0, PREVIEW_LINES_PER_FILE).join("\n");
        const tail = lines.length > PREVIEW_LINES_PER_FILE ? `\n... (+${lines.length - PREVIEW_LINES_PER_FILE} lines)` : "";
        return `--- ${p.relPath} (${p.byteLength} bytes) ---\n${shown}${tail}`;
      }).join("\n\n");

      const ok = await ctx.ui.confirm(`Promote ${plans.length} file(s) from ${drafterResults.length} subtasks?`, previewBody);
      if (!ok) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

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
          const actualSha = sha256(fs.readFileSync(p.destAbs, "utf8"));
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
  });
}
