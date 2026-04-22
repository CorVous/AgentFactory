import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 120_000;
const NOTIFY_TEXT_MAX = 400;

type ChildResult = {
  assistantText: string;
  assistantThinking: string;
  toolCalls: number;
  stderr: string;
  code: number;
  timedOut: boolean;
};

export default function(pi: ExtensionAPI) {

  async function runChild(
    phaseLabel: string,
    args: string[],
    ctx: { ui: { notify: (m: string, level: "info" | "warning" | "error") => void } },
    timeoutMs = PHASE_TIMEOUT_MS,
  ): Promise<ChildResult> {
    return new Promise((resolve) => {
      const fullArgs = ["--mode", "json", ...args];
      // Pi blocks reading stdin when it's a pipe, even with -p. Use "ignore"
      // so the child proceeds straight to the prompt from argv.
      const child = spawn("pi", fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      let stderr = "";
      let assistantText = "";
      let assistantThinking = "";
      let toolCalls = 0;
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
            const inputObj = (e.toolCall as { input?: unknown } | undefined)?.input;
            const inputPreview = inputObj ? JSON.stringify(inputObj).slice(0, 80) : "";
            ctx.ui.notify(`${phaseLabel} → ${name}${inputPreview ? " " + inputPreview : ""}`, "info");
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
        resolve({ assistantText, assistantThinking, toolCalls, stderr, code: code ?? 0, timedOut });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ assistantText, assistantThinking, toolCalls, stderr, code: -1, timedOut });
      });
    });
  }

  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

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
    ctx.ui.notify(`${phaseLabel} finished: ${res.toolCalls} tool call(s), exit ${res.code}`, "info");
  };

  pi.registerCommand("deferred-writer", {
    description: "Propose and write a file using separate planner and writer agents",
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

      ctx.ui.notify(`Planning target and content (model=${MODEL}, up to ${PHASE_TIMEOUT_MS / 1000}s)…`, "info");

      const plannerPrompt = `You are a PLANNER. Task: ${args}.

Call \`ls\` on the current directory AT MOST ONCE to see what names are taken. Do not call any other tool. Do not explore subdirectories. Do not read files — the destination path only needs to be a new name, not based on file contents.

Then pick a relative destination path (inside cwd, no '..', must not already exist) and draft the FULL content for that file.

Reply with EXACTLY one line and nothing else:
===PLAN=== {"path":"...","content":"..."} ===ENDPLAN===

Escape newlines in the content field as \\n. No prose before or after the PLAN markers.`;

      const res1 = await runChild(
        "Planner",
        ["-p", plannerPrompt, "--no-extensions", "--tools", "ls", "--provider", "openrouter", "--model", MODEL, "--thinking", "off", "--no-session"],
        ctx,
      );
      reportChild("Planner", res1, ctx);

      if (res1.timedOut) {
        ctx.ui.notify(`Planner timed out after ${PHASE_TIMEOUT_MS / 1000}s`, "error");
        return;
      }
      if (res1.code !== 0) {
        ctx.ui.notify(`Planner exited ${res1.code}. Stderr: ${res1.stderr.slice(-2000)}`, "error");
        return;
      }

      const match = res1.assistantText.match(/===PLAN===\s*([\s\S]*?)\s*===ENDPLAN===/);
      if (!match) {
        ctx.ui.notify("Planner did not produce ===PLAN=== markers in its final message.", "error");
        return;
      }

      let parsed: { path?: unknown; content?: unknown };
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        ctx.ui.notify("Failed to parse plan JSON: " + match[1].slice(0, 200), "error");
        return;
      }

      const fPath = parsed.path;
      const content = parsed.content;
      if (!fPath || typeof fPath !== "string" || path.isAbsolute(fPath) || fPath.split(path.sep).includes("..")) {
        ctx.ui.notify("Invalid path proposed by planner: " + String(fPath), "error");
        return;
      }
      if (typeof content !== "string") {
        ctx.ui.notify("Planner did not return string content.", "error");
        return;
      }
      if (fs.existsSync(fPath)) {
        ctx.ui.notify("Proposed file already exists: " + fPath, "error");
        return;
      }

      const lines = content.split("\n");
      const preview = lines.slice(0, 40).join("\n") + (lines.length > 40 ? `\n... (${lines.length - 40} more lines)` : "");
      if (!(await ctx.ui.confirm("Write new file?", fPath + "\n---\n" + preview))) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      if (fs.existsSync(fPath)) {
        ctx.ui.notify("File was created during confirmation: " + fPath, "error");
        return;
      }

      ctx.ui.notify(`Writing ${fPath}…`, "info");

      const expectedHash = sha256(content);
      const writerPrompt = `Use the write tool EXACTLY ONCE to create the file at path: ${fPath}. The content is between <<<BEGIN>>> and <<<END>>> markers (exclusive):\n<<<BEGIN>>>\n${content}\n<<<END>>>\nDo not modify any other file. After writing, reply DONE.`;

      const res2 = await runChild(
        "Writer",
        ["-p", writerPrompt, "--no-extensions", "--tools", "write", "--provider", "openrouter", "--model", MODEL, "--thinking", "off", "--no-session"],
        ctx,
      );
      reportChild("Writer", res2, ctx);

      if (res2.timedOut) {
        ctx.ui.notify(`Writer timed out after ${PHASE_TIMEOUT_MS / 1000}s`, "error");
        return;
      }
      if (res2.code !== 0) {
        ctx.ui.notify(`Writer exited ${res2.code}. Stderr: ${res2.stderr.slice(-2000)}`, "error");
        return;
      }

      if (!fs.existsSync(fPath) || sha256(fs.readFileSync(fPath, "utf-8")) !== expectedHash) {
        ctx.ui.notify("Writer completed but file missing or hash mismatch.", "error");
        return;
      }

      ctx.ui.notify("Wrote: " + fPath, "info");
    },
  });
}
