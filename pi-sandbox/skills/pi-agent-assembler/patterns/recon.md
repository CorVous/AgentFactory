# Pattern: `recon`

**When to use:** user wants a read-only survey of a directory,
codebase, or fixture. The child walks the inputs and emits a
bounded text summary; nothing is written.

## Short-prompt signals that match

- "summarize what's in `<dir>`"
- "read the project and give me a one-pager"
- "survey / explore / audit / index this directory"
- "what does this codebase look like"

If the prompt also says "and write the summary to `<file>`" that's
still recon — the *parent* writes the summary file, not the child.
The child remains read-only.

## Parts

None from the write library. Recon deliberately does NOT load
cwd-guard — the child has no write tool at all.

The parent's role:

- Spawn a child with a read-only `--tools` allowlist.
- Harvest the child's final assistant text from `message_end`
  events.
- Enforce a byte-length cap on the summary (`.slice(0, N)` or
  `Buffer.byteLength`).
- Write the summary to `.pi/scratch/<name>.md` (parent-side, using
  the built-in `write` — the parent isn't sandboxed by cwd-guard).

## `--tools` allowlist

Exactly read-only verbs: `ls,read,grep,glob`.

Forbidden: `write`, `edit`, `stage_write`, `bash`. The allowlist
is what makes this pattern "recon" — anything that can mutate
state disqualifies it.

## Model tier

`$TASK_MODEL`. Recon is bulk task execution — survey, summarize,
move on. Cheap-per-token is the right shape.

## Skeleton

Save this file as `.pi/extensions/<TODO:CMD_NAME>.ts` under the
project's sandbox directory. Files at the cwd root are NOT
auto-discovered by pi and won't register.

```ts
// .pi/extensions/TODO:CMD_NAME.ts — recon agent.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 120_000;
const SUMMARY_BYTE_CAP = 8_000;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("TODO:CMD_NAME", {
    description: "TODO:CMD_DESCRIPTION",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /TODO:CMD_NAME <relative-dir>", "warning");
        return;
      }
      const MODEL = process.env.TASK_MODEL;
      if (!MODEL) {
        ctx.ui.notify("TASK_MODEL env var not set. Source models.env.", "error");
        return;
      }
      const sandboxRoot = path.resolve(process.cwd());
      const targetAbs = path.resolve(sandboxRoot, target);
      if (targetAbs !== sandboxRoot && !targetAbs.startsWith(sandboxRoot + path.sep)) {
        ctx.ui.notify(`${target}: escapes sandbox ${sandboxRoot}`, "error");
        return;
      }

      const agentPrompt =
        `You are a RECON AGENT. Survey ${targetAbs} and produce a bounded ` +
        `summary. Use only 'ls', 'read', 'grep', 'glob' (no write, no edit, ` +
        `no bash). Return a concise report (<= ${SUMMARY_BYTE_CAP} bytes) ` +
        `naming the files/directories you actually saw. ` +
        `TODO:AGENT_PROMPT`;

      let summary = "";
      const child = spawn(
        "pi",
        [
          "--mode", "json",
          "--tools", "ls,read,grep,glob",
          "--no-extensions",
          "--provider", "openrouter",
          "--model", MODEL,
          "--no-session",
          "--thinking", "off",
          "-p", agentPrompt,
        ],
        { stdio: ["ignore", "pipe", "pipe"], cwd: sandboxRoot },
      );

      let buffer = "";
      let stderr = "";
      let toolCalls = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, PHASE_TIMEOUT_MS);

      child.stdout.on("data", (d) => {
        buffer += d.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let e: Record<string, unknown>;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.type === "tool_execution_start") {
            toolCalls++;
            ctx.ui.notify(`Recon → ${e.toolName}`, "info");
          } else if (e.type === "message_end") {
            const msg = e.message as { role?: string; content?: unknown } | undefined;
            if (msg?.role === "assistant" && Array.isArray(msg.content)) {
              for (const part of msg.content as Array<{ type?: string; text?: string }>) {
                if (part?.type === "text" && typeof part.text === "string") {
                  summary = part.text;
                }
              }
            }
          }
        }
      });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      await new Promise<void>((resolve) => {
        child.on("close", () => { clearTimeout(timer); resolve(); });
        child.on("error", () => { clearTimeout(timer); resolve(); });
      });

      if (timedOut) {
        ctx.ui.notify(`Recon timed out after ${PHASE_TIMEOUT_MS / 1000}s.`, "error");
        return;
      }
      if (!summary) {
        ctx.ui.notify(`Recon produced no summary. Stderr: ${stderr.slice(-1000)}`, "error");
        return;
      }

      // Bounded summary. TODO:VALIDATION — add task-specific checks here.
      if (Buffer.byteLength(summary, "utf8") > SUMMARY_BYTE_CAP) {
        summary = summary.slice(0, SUMMARY_BYTE_CAP) + "\n…(truncated)";
      }

      const outDir = path.resolve(sandboxRoot, ".pi/scratch");
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, "TODO:CMD_NAME-summary.md");
      fs.writeFileSync(outPath, summary, "utf8");
      ctx.ui.notify(
        `Recon complete (${toolCalls} tool call(s), ${Buffer.byteLength(summary, "utf8")} bytes). Summary: ${outPath}`,
        "info",
      );
    },
  });
}
```

## Validation checklist

Before handing this extension back, verify the emitted file
contains each of these anchors:

- `registerCommand("TODO:CMD_NAME"` — replaced with the chosen
  slash command name.
- `"--tools", "ls,read,grep,glob"` — read-only allowlist, no
  writers.
- `"--no-extensions"` on the spawn args.
- `setTimeout(…, PHASE_TIMEOUT_MS)` + `child.kill("SIGKILL")` — hard
  timeout.
- `Buffer.byteLength(summary, "utf8") > SUMMARY_BYTE_CAP` — a
  byte-length cap on the harvested summary.
- `fs.writeFileSync(outPath, summary, "utf8")` — parent writes the
  summary (not the child).
- NO `-e <…stage-write…>`, NO `-e <…cwd-guard…>`. Recon loads
  neither.
- NO `ctx.ui.confirm` call. Recon has no side effect to gate.
