import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 120_000;
const NOTIFY_TEXT_MAX = 400;
const PREVIEW_LINES_PER_FILE = 20;
const MAX_FILES_PROMOTABLE = 50;
const MAX_CONTENT_BYTES_PER_FILE = 2_000_000;

// Path to the child-only stage_write tool we load via -e. Computed relative
// to THIS extension file so the layout is self-contained.
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
      // Pi blocks reading stdin when it's a pipe, even with -p. Use "ignore"
      // so the child proceeds straight to the prompt from argv.
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

  const reportChild = (
    phaseLabel: string,
    res: ChildResult,
    ctx: { ui: { notify: (m: string, level: "info" | "warning" | "error") => void } },
  ) => {
    if (res.assistantThinking) {
      ctx.ui.notify(`${phaseLabel} thinking: ${trunc(res.assistantThinking)}`, "info");
    }
    if (res.assistantText) {
      ctx.ui.notify(`${phaseLabel} text: ${trunc(res.assistantText)}`, "info");
    }
    ctx.ui.notify(`${phaseLabel} finished: ${res.toolCalls} tool call(s), ${res.stagedWrites.length} drafted file(s), exit ${res.code}`, "info");
  };

  pi.registerCommand("deferred-writer", {
    description: "Drafter agent stages writes in memory; user reviews and approves before anything hits disk",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /deferred-writer <task description>", "warning");
        return;
      }

      const MODEL = process.env.TASK_MODEL;
      if (!MODEL) {
        ctx.ui.notify("TASK_MODEL env var not set. Source models.env before launching pi.", "error");
        return;
      }

      if (!fs.existsSync(STAGE_WRITE_TOOL)) {
        ctx.ui.notify(`stage_write tool missing at ${STAGE_WRITE_TOOL}`, "error");
        return;
      }

      const sandboxRoot = path.resolve(process.cwd());

      ctx.ui.notify(`Drafting (model=${MODEL}, sandbox=${sandboxRoot}, buffer=memory, up to ${PHASE_TIMEOUT_MS / 1000}s)…`, "info");

      const agentPrompt = `You are a DRAFTER. Task: ${args}.

Nothing you do will touch disk until the user approves. To create a file, call the \`stage_write\` tool with a relative \`path\` (inside the project at ${sandboxRoot}) and the full \`content\`. The content stays buffered in the parent's memory; the user will see every draft and only then decide whether to persist them.

Rules:
- Do NOT call any \`write\` tool — only \`stage_write\`.
- Paths must be relative, inside ${sandboxRoot}, no \`..\` segments.
- To inspect the existing project, use \`read\` / \`ls\` on ABSOLUTE paths under ${sandboxRoot}.
- Stop after you've staged everything the task needs. Reply DONE and stop.`;

      const res = await runChild(
        "Drafter",
        [
          "-e", STAGE_WRITE_TOOL,
          "-p", agentPrompt,
          "--no-extensions",
          "--tools", "stage_write,ls,read",
          "--provider", "openrouter",
          "--model", MODEL,
          "--thinking", "off",
          "--no-session",
        ],
        ctx,
        PHASE_TIMEOUT_MS,
        sandboxRoot,
      );
      reportChild("Drafter", res, ctx);

      if (res.timedOut) {
        ctx.ui.notify(`Drafter timed out after ${PHASE_TIMEOUT_MS / 1000}s. Drafts discarded.`, "error");
        return;
      }
      if (res.code !== 0) {
        ctx.ui.notify(`Drafter exited ${res.code}. Stderr: ${res.stderr.slice(-2000)}. Drafts discarded.`, "error");
        return;
      }
      if (res.stagedWrites.length === 0) {
        ctx.ui.notify("Drafter made no stage_write calls.", "warning");
        return;
      }
      if (res.stagedWrites.length > MAX_FILES_PROMOTABLE) {
        ctx.ui.notify(`Drafter staged ${res.stagedWrites.length} files (> ${MAX_FILES_PROMOTABLE}); aborting for safety.`, "error");
        return;
      }

      const plans: StagedWrite[] = [];
      const skips: string[] = [];
      for (const s of res.stagedWrites) {
        if (typeof s.path !== "string" || s.path.length === 0) {
          skips.push(`<invalid path type: ${typeof s.path}>`);
          continue;
        }
        if (typeof s.content !== "string") {
          skips.push(`${s.path}: content is ${typeof s.content}, expected string`);
          continue;
        }
        const relPath = s.path;
        if (path.isAbsolute(relPath) || relPath.split("/").includes("..") || relPath.split(path.sep).includes("..")) {
          skips.push(`${relPath}: absolute or contains '..'`);
          continue;
        }
        const destAbs = path.resolve(sandboxRoot, relPath);
        if (destAbs !== sandboxRoot && !destAbs.startsWith(sandboxRoot + path.sep)) {
          skips.push(`${relPath}: escapes sandbox`);
          continue;
        }
        if (fs.existsSync(destAbs)) {
          skips.push(`${relPath}: destination exists at ${destAbs}`);
          continue;
        }
        const byteLength = Buffer.byteLength(s.content, "utf8");
        if (byteLength > MAX_CONTENT_BYTES_PER_FILE) {
          skips.push(`${relPath}: ${byteLength} bytes > ${MAX_CONTENT_BYTES_PER_FILE} limit`);
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

      for (const skip of skips) {
        ctx.ui.notify(`Skipping ${skip}`, "warning");
      }

      if (plans.length === 0) {
        ctx.ui.notify("No promotable drafts after validation.", "warning");
        return;
      }

      const previewSections = plans.map((p) => {
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
        `Promote ${plans.length} file(s)?`,
        previewBody,
      );
      if (!ok) {
        ctx.ui.notify("Cancelled; nothing written to the project.", "info");
        return;
      }

      const promoted: string[] = [];
      const failures: string[] = [];
      for (const p of plans) {
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
        ctx.ui.notify(`Promotion had ${failures.length} failure(s):\n${failures.join("\n")}`, "error");
      }
      if (promoted.length > 0) {
        ctx.ui.notify(`Wrote ${promoted.length} file(s):\n${promoted.join("\n")}`, "info");
      }
    },
  });
}
