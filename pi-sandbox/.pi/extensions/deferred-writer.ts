import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 120_000;

export default function(pi: ExtensionAPI) {
  const MODEL = process.env.TASK_MODEL ?? "openrouter/anthropic/claude-haiku-4-5";

  async function runChild(
    args: string[],
    timeoutMs = PHASE_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn("pi", args);
      let stdout = "", stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 0, timedOut });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: -1, timedOut });
      });
    });
  }

  const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

  pi.registerCommand("deferred-writer", {
    description: "Propose and write a file using separate planner and writer agents",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /deferred-writer <task description>", "warning");
        return;
      }

      ctx.ui.notify(`Planning target and content (model=${MODEL}, up to ${PHASE_TIMEOUT_MS / 1000}s)...`, "info");

      const plannerPrompt = `You are a PLANNER. Task: ${args}. Use ls and read to survey the repo, pick ONE destination file path (relative, inside cwd, no '..', must not exist), and draft the FULL content for that file. Reply with EXACTLY one line: <plan>{"path":"...","content":"..."}</plan>. Escape newlines in content as \\n.`;

      const res1 = await runChild(["-p", plannerPrompt, "--no-extensions", "--tools", "ls,read", "--model", MODEL, "--no-session"]);
      if (res1.timedOut) {
        ctx.ui.notify(`Planner timed out after ${PHASE_TIMEOUT_MS / 1000}s. Stderr: ${res1.stderr.slice(-2000)}`, "error");
        return;
      }
      if (res1.code !== 0) {
        ctx.ui.notify(`Planner exited ${res1.code}. Stderr: ${res1.stderr.slice(-2000)}`, "error");
        return;
      }
      const match = res1.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
      if (!match) {
        ctx.ui.notify("Planner failed to produce a <plan>...</plan> payload. Output: " + res1.stdout.slice(-2000), "error");
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

      ctx.ui.notify(`Writing ${fPath}...`, "info");

      const expectedHash = sha256(content);
      const writerPrompt = `Use the write tool EXACTLY ONCE to create the file at path: ${fPath}. The content is between <<<BEGIN>>> and <<<END>>> markers (exclusive):\n<<<BEGIN>>>\n${content}\n<<<END>>>\nDo not modify any other file. After writing, reply DONE.`;

      const res2 = await runChild(["-p", writerPrompt, "--no-extensions", "--tools", "write", "--model", MODEL, "--no-session"]);
      if (res2.timedOut) {
        ctx.ui.notify(`Writer timed out after ${PHASE_TIMEOUT_MS / 1000}s. Stderr: ${res2.stderr.slice(-2000)}`, "error");
        return;
      }
      if (res2.code !== 0) {
        ctx.ui.notify(`Writer exited ${res2.code}. Stderr: ${res2.stderr.slice(-2000)}`, "error");
        return;
      }

      if (!fs.existsSync(fPath) || sha256(fs.readFileSync(fPath, "utf-8")) !== expectedHash) {
        ctx.ui.notify("Writer completed but file missing or hash mismatch. Stderr: " + res2.stderr.slice(-2000), "error");
        return;
      }

      ctx.ui.notify("Wrote: " + fPath, "info");
    },
  });
}
