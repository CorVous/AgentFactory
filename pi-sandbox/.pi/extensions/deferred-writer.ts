import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 120_000;
const NOTIFY_TEXT_MAX = 400;
const PREVIEW_LINES_PER_FILE = 20;
const MAX_FILES_PROMOTABLE = 50;

type ChildResult = {
  assistantText: string;
  assistantThinking: string;
  toolCalls: number;
  stderr: string;
  code: number;
  timedOut: boolean;
};

type StagedFile = {
  relPath: string;       // relative to stagingDir
  stagingAbs: string;    // absolute path inside stagingDir
  destAbs: string;       // absolute path inside sandboxRoot
  content: Buffer;
  sha: string;
  isText: boolean;
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
      // so the child proceeds straight to the prompt from argv. Pin cwd so
      // relative writes land in the staging directory.
      const child = spawn("pi", fullArgs, { stdio: ["ignore", "pipe", "pipe"], cwd });
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
            const inputPreview = inputObj ? JSON.stringify(inputObj).slice(0, 120) : "";
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

  const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

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

  function walkStaging(dir: string, relBase = ""): { relPath: string; abs: string }[] {
    const out: { relPath: string; abs: string }[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walkStaging(abs, rel));
      } else if (entry.isFile()) {
        out.push({ relPath: rel, abs });
      }
    }
    return out;
  }

  pi.registerCommand("deferred-writer", {
    description: "Drafter agent writes into a staging area; user reviews and approves before promotion",
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

      const sandboxRoot = path.resolve(process.cwd());
      const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "deferred-writer-"));

      try {
        ctx.ui.notify(`Drafting (model=${MODEL}, sandbox=${sandboxRoot}, staging=${stagingDir}, up to ${PHASE_TIMEOUT_MS / 1000}s)…`, "info");

        const agentPrompt = `You are a DRAFTER. Task: ${args}.

Your current working directory is a STAGING area. Any file you create with the \`write\` tool will be drafted there and shown to the user for approval before being promoted into the real project.

Rules:
- Create files using relative paths. They'll land in the staging dir and later be promoted to the same relative path under the project root ${sandboxRoot}.
- To inspect the existing project, use ABSOLUTE paths rooted at ${sandboxRoot} (e.g. \`read ${sandboxRoot}/package.json\`, \`ls ${sandboxRoot}\`).
- Do NOT write to absolute paths — absolute writes won't be promoted.
- Do not call the same tool in a loop. Do the minimum work needed, then stop.
- When every needed file is drafted, reply DONE and stop.`;

        const res = await runChild(
          "Drafter",
          ["-p", agentPrompt, "--no-extensions", "--tools", "write,ls,read", "--provider", "openrouter", "--model", MODEL, "--thinking", "off", "--no-session"],
          ctx,
          PHASE_TIMEOUT_MS,
          stagingDir,
        );
        reportChild("Drafter", res, ctx);

        if (res.timedOut) {
          ctx.ui.notify(`Drafter timed out after ${PHASE_TIMEOUT_MS / 1000}s. Staged files will be discarded.`, "error");
          return;
        }
        if (res.code !== 0) {
          ctx.ui.notify(`Drafter exited ${res.code}. Stderr: ${res.stderr.slice(-2000)}. Staged files will be discarded.`, "error");
          return;
        }

        const staged = walkStaging(stagingDir);
        if (staged.length === 0) {
          ctx.ui.notify("Drafter produced no staged files.", "warning");
          return;
        }
        if (staged.length > MAX_FILES_PROMOTABLE) {
          ctx.ui.notify(`Drafter produced ${staged.length} files (> ${MAX_FILES_PROMOTABLE}); aborting for safety.`, "error");
          return;
        }

        const plans: StagedFile[] = [];
        const skips: string[] = [];
        for (const s of staged) {
          const destAbs = path.resolve(sandboxRoot, s.relPath);
          if (destAbs !== sandboxRoot && !destAbs.startsWith(sandboxRoot + path.sep)) {
            skips.push(`${s.relPath} → escapes sandbox`);
            continue;
          }
          if (fs.existsSync(destAbs)) {
            skips.push(`${s.relPath} → ${destAbs} already exists`);
            continue;
          }
          const content = fs.readFileSync(s.abs);
          // Crude binary detection: files with NUL bytes aren't text.
          const isText = !content.includes(0);
          plans.push({
            relPath: s.relPath,
            stagingAbs: s.abs,
            destAbs,
            content,
            sha: sha256(content),
            isText,
          });
        }

        for (const skip of skips) {
          ctx.ui.notify(`Skipping ${skip}`, "warning");
        }

        if (plans.length === 0) {
          ctx.ui.notify("No promotable files after sandbox + existence checks.", "warning");
          return;
        }

        const previewSections = plans.map((p) => {
          const header = `${p.destAbs} (${p.content.length} bytes, sha ${p.sha.slice(0, 10)}…)`;
          if (!p.isText) {
            return `${header}\n<binary; preview omitted>`;
          }
          const text = p.content.toString("utf8");
          const lines = text.split("\n");
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
            fs.copyFileSync(p.stagingAbs, p.destAbs);
            const actualSha = sha256(fs.readFileSync(p.destAbs));
            if (actualSha !== p.sha) {
              failures.push(`${p.relPath}: hash mismatch after copy`);
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
      } finally {
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // Cleanup failure is non-fatal; tmp cleanup will eventually reap.
        }
      }
    },
  });
}
