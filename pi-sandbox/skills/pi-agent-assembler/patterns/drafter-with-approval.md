# Pattern: `drafter-with-approval`

**When to use:** user wants the agent to draft one or more files
but review them before anything hits disk. The child drafter
stages writes via `stage_write`; the parent harvests them, previews
via `ctx.ui.confirm`, and `fs.writeFileSync`s approved drafts only.

## Short-prompt signals that match

- "write X — but show me before it saves"
- "draft the file, I'll approve"
- "stage and preview"
- "create <X>, but don't commit / save / write until I say"

## Parts

In load order on the child:

1. `cwd-guard.ts` — even though the canonical write channel is
   `stage_write` (which doesn't touch disk), cwd-guard is loaded
   as a safety backstop: if the child somehow gains a write
   primitive, the sandbox root still holds.
2. `stage-write.ts` — the stub write channel.

## `--tools` allowlist on the child

```
stage_write,ls
```

Add `read` only if the drafter genuinely needs to inspect existing
files. Omit everything else — the pattern depends on `stage_write`
being the only write path.

## Model tier

`$TASK_MODEL`. Drafting is bulk worker output; frontier reasoning
isn't needed.

## Canonical assembled example

`pi-sandbox/.pi/extensions/deferred-writer.ts`. The skeleton below
is a trimmed version of its wiring — the confirm dialog, promotion
loop, sha256 verification, and caps.

## Skeleton

Save this file as `.pi/extensions/<TODO:CMD_NAME>.ts` under the
project's sandbox directory. Files at the cwd root are NOT
auto-discovered by pi and won't register.

```ts
// .pi/extensions/TODO:CMD_NAME.ts — drafter with user approval gate.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 120_000;
const MAX_FILES_PROMOTABLE = 50;
const MAX_CONTENT_BYTES_PER_FILE = 2_000_000;
const PREVIEW_LINES_PER_FILE = 20;

const CWD_GUARD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "cwd-guard.ts",
);
const STAGE_WRITE_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "stage-write.ts",
);

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("TODO:CMD_NAME", {
    description: "TODO:CMD_DESCRIPTION",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /TODO:CMD_NAME <task description>", "warning");
        return;
      }
      const MODEL = process.env.TASK_MODEL;
      if (!MODEL) {
        ctx.ui.notify("TASK_MODEL env var not set. Source models.env.", "error");
        return;
      }
      if (!fs.existsSync(STAGE_WRITE_TOOL) || !fs.existsSync(CWD_GUARD)) {
        ctx.ui.notify("components missing; check pi-sandbox/.pi/components/", "error");
        return;
      }
      const sandboxRoot = path.resolve(process.cwd());

      const agentPrompt =
        `You are a DRAFTER. Task: ${args}.\n\n` +
        `Nothing you do will touch disk until the user approves. Call ` +
        `stage_write({path, content}) with a RELATIVE path inside ${sandboxRoot} ` +
        `and the full content. Do NOT call any write/edit tool. ` +
        `TODO:AGENT_PROMPT Reply DONE and stop.`;

      const stagedWrites: Array<{ path: unknown; content: unknown }> = [];
      const child = spawn(
        "pi",
        [
          "-e", CWD_GUARD,
          "-e", STAGE_WRITE_TOOL,
          "--mode", "json",
          "--tools", "stage_write,ls",
          "--no-extensions",
          "--provider", "openrouter",
          "--model", MODEL,
          "--no-session",
          "--thinking", "off",
          "-p", agentPrompt,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: sandboxRoot,
          env: { ...process.env, PI_SANDBOX_ROOT: sandboxRoot },
        },
      );

      let buffer = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, PHASE_TIMEOUT_MS);

      child.stdout.on("data", (d) => {
        buffer += d.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let e: Record<string, unknown>;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.type === "tool_execution_start" && e.toolName === "stage_write") {
            const a = e.args as Record<string, unknown> | undefined;
            if (a) {
              stagedWrites.push({ path: a.path, content: a.content });
              const p = typeof a.path === "string" ? a.path : "<?>";
              const len = typeof a.content === "string" ? a.content.length : 0;
              ctx.ui.notify(`Drafter → stage_write ${p} (${len} chars)`, "info");
            }
          } else if (e.type === "tool_execution_start") {
            ctx.ui.notify(`Drafter → ${e.toolName}`, "info");
          }
        }
      });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      const code = await new Promise<number>((resolve) => {
        child.on("close", (c) => { clearTimeout(timer); resolve(c ?? 0); });
        child.on("error", () => { clearTimeout(timer); resolve(-1); });
      });

      if (timedOut) { ctx.ui.notify(`Drafter timed out; drafts discarded.`, "error"); return; }
      if (code !== 0) { ctx.ui.notify(`Drafter exit ${code}. Stderr: ${stderr.slice(-2000)}`, "error"); return; }
      if (stagedWrites.length === 0) { ctx.ui.notify("Drafter made no stage_write calls.", "warning"); return; }
      if (stagedWrites.length > MAX_FILES_PROMOTABLE) {
        ctx.ui.notify(`Drafter staged ${stagedWrites.length} files (> ${MAX_FILES_PROMOTABLE}); aborting.`, "error");
        return;
      }

      const plans: Array<{ relPath: string; destAbs: string; content: string; sha: string; byteLength: number }> = [];
      const skips: string[] = [];
      for (const s of stagedWrites) {
        if (typeof s.path !== "string" || !s.path) { skips.push(`<invalid path>`); continue; }
        if (typeof s.content !== "string") { skips.push(`${s.path}: non-string content`); continue; }
        if (path.isAbsolute(s.path) || s.path.split("/").includes("..")) { skips.push(`${s.path}: absolute or '..'`); continue; }
        const destAbs = path.resolve(sandboxRoot, s.path);
        if (destAbs !== sandboxRoot && !destAbs.startsWith(sandboxRoot + path.sep)) { skips.push(`${s.path}: escapes sandbox`); continue; }
        if (fs.existsSync(destAbs)) { skips.push(`${s.path}: exists`); continue; }
        const bytes = Buffer.byteLength(s.content, "utf8");
        if (bytes > MAX_CONTENT_BYTES_PER_FILE) { skips.push(`${s.path}: ${bytes} bytes > cap`); continue; }
        plans.push({ relPath: s.path, destAbs, content: s.content, sha: sha256(s.content), byteLength: bytes });
      }
      for (const skip of skips) ctx.ui.notify(`Skipping ${skip}`, "warning");
      if (plans.length === 0) { ctx.ui.notify("No promotable drafts.", "warning"); return; }

      // TODO:VALIDATION — insert task-specific post-drafter checks here
      // (e.g. require a specific filename, reject unless all files share a
      // prefix, etc.). Default: no extra checks.

      const previewBody = plans.map((p) => {
        const head = `${p.destAbs} (${p.byteLength} bytes, sha ${p.sha.slice(0, 10)}…)`;
        const lines = p.content.split("\n");
        const shown = lines.slice(0, PREVIEW_LINES_PER_FILE).join("\n");
        const tail = lines.length > PREVIEW_LINES_PER_FILE ? `\n… (+${lines.length - PREVIEW_LINES_PER_FILE} more)` : "";
        return `${head}\n${shown}${tail}`;
      }).join("\n\n---\n\n");

      const ok = await ctx.ui.confirm(`Promote ${plans.length} file(s)?`, previewBody);
      if (!ok) { ctx.ui.notify("Cancelled; nothing written.", "info"); return; }

      const promoted: string[] = [];
      const failures: string[] = [];
      for (const p of plans) {
        if (fs.existsSync(p.destAbs)) { failures.push(`${p.relPath}: exists now`); continue; }
        try {
          fs.mkdirSync(path.dirname(p.destAbs), { recursive: true });
          fs.writeFileSync(p.destAbs, p.content, "utf8");
          const actual = sha256(fs.readFileSync(p.destAbs, "utf8"));
          if (actual !== p.sha) { failures.push(`${p.relPath}: hash mismatch`); continue; }
          promoted.push(p.destAbs);
        } catch (e) { failures.push(`${p.relPath}: ${(e as Error).message}`); }
      }
      if (failures.length > 0) ctx.ui.notify(`Promotion failures:\n${failures.join("\n")}`, "error");
      if (promoted.length > 0) ctx.ui.notify(`Wrote ${promoted.length} file(s):\n${promoted.join("\n")}`, "info");
    },
  });
}
```

## Validation checklist

- `registerCommand("TODO:CMD_NAME"` filled in.
- `-e CWD_GUARD` AND `-e STAGE_WRITE_TOOL` both present on the
  spawn args.
- `PI_SANDBOX_ROOT: sandboxRoot` in the child env.
- `"--tools", "stage_write,ls"` (or `stage_write,ls,read` if
  explicitly justified). NO `write`, `edit`, `bash`, or real
  `sandbox_write` in the allowlist — the drafter should only reach
  disk via staging.
- `"--no-extensions"` and `"--no-session"`.
- `setTimeout(..., PHASE_TIMEOUT_MS)` + `child.kill("SIGKILL")`.
- `stdio: ["ignore", "pipe", "pipe"]`.
- `stagedWrites.length > MAX_FILES_PROMOTABLE` cap check.
- `Buffer.byteLength(...) > MAX_CONTENT_BYTES_PER_FILE` cap check
  per file.
- Path validation: rejects absolute paths and `..` segments.
- `ctx.ui.confirm(...)` before any `fs.writeFileSync`.
- sha256 verification after write.
- Cancel path (`ok === false`) exits cleanly with a notify.
