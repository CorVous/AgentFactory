import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  const MODEL = process.env.TASK_MODEL ?? "openrouter/anthropic/claude-haiku-4-5";

  async function runChild(args: string[], input?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const child = spawn("pi", args);
      let stdout = "", stderr = "";
      if (input) {
        child.stdin.write(input);
        child.stdin.end();
      }
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
  }

  const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

  pi.registerCommand("deferred-writer", {
    description: "Propose and write a file using separate planner and writer agents",
    handler: async (args, ctx) => {
      const plannerPrompt = `You are a PLANNER. Task: ${args}. Use ls and read to survey the repo, pick ONE destination file path (relative, inside cwd, no '..', must not exist), and draft the FULL content for that file. Reply with EXACTLY one line: <plan>{"path":"...","content":"..."}</plan>. Escape newlines in content as \\n.`;

      const res1 = await runChild(["-p", plannerPrompt, "--no-extensions", "--tools", "ls,read", "--model", MODEL, "--no-session"]);
      const match = res1.stdout.match(/<plan>(.*?)<\/plan>/);
      if (!match) {
        ctx.ui.notify("Planner failed to produce a plan. Output: " + res1.stdout.slice(0, 2000), "error");
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(match[1]);
      } catch (e) {
        ctx.ui.notify("Failed to parse plan JSON: " + match[1].slice(0, 100), "error");
        return;
      }

      const { path: fPath, content } = parsed;
      if (!fPath || typeof fPath !== "string" || path.isAbsolute(fPath) || fPath.includes("..")) {
        ctx.ui.notify("Invalid path proposed by planner: " + fPath, "error");
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

      const expectedHash = sha256(content);
      const writerPrompt = `Use the write tool EXACTLY ONCE to create the file at path: ${fPath}. The content is between <<<BEGIN>>> and <<<END>>> markers (exclusive):\n<<<BEGIN>>>\n${content}\n<<<END>>>\nDo not modify any other file. After writing, reply DONE.`;

      const res2 = await runChild(["-p", writerPrompt, "--no-extensions", "--tools", "write", "--model", MODEL, "--no-session"]);

      const exists = fs.existsSync(fPath);
      const hashMatch = exists && sha256(fs.readFileSync(fPath, "utf-8")) === expectedHash;
      if (!hashMatch) {
        ctx.ui.notify("Writer failed or hash mismatch. Stderr: " + res2.stderr.slice(0, 2000), "error");
        return;
      }

      ctx.ui.notify("Wrote: " + fPath, "info");
    },
  });
}
