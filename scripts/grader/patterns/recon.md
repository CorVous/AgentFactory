# Pattern: `recon`

**When to use:** user wants a read-only survey of a directory,
codebase, or fixture. The child walks the inputs and emits bounded,
structured summaries via `emit_summary`; nothing is written.

## Short-prompt signals that match

- "summarize what's in `<dir>`"
- "read the project and give me a one-pager"
- "survey / explore / audit / index this directory"
- "what does this codebase look like"

If the prompt also says "and write the summary to `<file>`" that's
still recon — the *parent* writes the summary file, not the child.
The child remains read-only.

## Parts

In load order on the child:

1. `cwd-guard.ts` — supplies the path-validated read verbs
   (`sandbox_read`, `sandbox_ls`, `sandbox_grep`, `sandbox_glob`).
   The pi built-ins `read`/`ls`/`grep`/`glob` are forbidden across
   the project, so cwd-guard is mandatory whenever the child needs
   to read the filesystem — including recon. The parent passes
   `PI_SANDBOX_VERBS` listing only the read verbs (no
   `sandbox_write`/`sandbox_edit`), so cwd-guard registers no write
   channel and the recon child remains read-only by construction.
2. `emit-summary.ts` — the stub the child calls with `{title, body}`
   to hand a structured summary back to the parent. The child MUST
   NOT produce summaries as free-form assistant text — the parent
   harvests `emit_summary` calls from the NDJSON event stream and
   has no robust way to use text-in-message.

The parent's role:

- Spawn a child with a read-only `--tools` allowlist plus
  `emit_summary`.
- Harvest `{title, body}` from every `tool_execution_start` event
  where `toolName === "emit_summary"`.
- Enforce a byte-length cap on each body (and optionally a total
  cap across all summaries).
- Concatenate (or pick one) and write the result to
  `.pi/scratch/<name>-summary.md` with the parent's built-in
  `fs.writeFileSync` — the parent isn't sandboxed by cwd-guard.

## `--tools` allowlist

Exactly the sandbox read verbs plus the emit stub:
`sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob,emit_summary`.

Forbidden: every built-in fs verb (`read`, `ls`, `grep`, `glob`,
`write`, `edit`), `bash`, and `stage_write`. The allowlist is what
makes this pattern "recon" — anything that can mutate state
disqualifies it.

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
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 120_000;
const SUMMARY_BYTE_CAP = 8_000;
const TOTAL_BYTE_CAP = 32_000;

const EMIT_SUMMARY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "emit-summary.ts",
);
const CWD_GUARD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "cwd-guard.ts",
);
const RECON_VERBS = "sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob";

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
      if (!fs.existsSync(EMIT_SUMMARY) || !fs.existsSync(CWD_GUARD)) {
        ctx.ui.notify(`recon components missing; check pi-sandbox/.pi/components/`, "error");
        return;
      }
      const sandboxRoot = path.resolve(process.cwd());
      const targetAbs = path.resolve(sandboxRoot, target);
      if (targetAbs !== sandboxRoot && !targetAbs.startsWith(sandboxRoot + path.sep)) {
        ctx.ui.notify(`${target}: escapes sandbox ${sandboxRoot}`, "error");
        return;
      }

      const agentPrompt =
        `You are a RECON AGENT. Survey ${targetAbs} and produce bounded ` +
        `summaries. Use only 'sandbox_ls', 'sandbox_read', 'sandbox_grep', ` +
        `'sandbox_glob' (no write, no edit, no bash). Instead of producing a ` +
        `final assistant message, call ` +
        `emit_summary({title, body}) with a short title and a body <= ${SUMMARY_BYTE_CAP} ` +
        `bytes naming the files/directories you actually saw. Call it once for ` +
        `the overall directory survey; call it a second time only if you have ` +
        `a distinct, differently-scoped view to report. ` +
        `TODO:AGENT_PROMPT Reply DONE and stop.`;

      const summaries: Array<{ title: string; body: string }> = [];
      const child = spawn(
        "pi",
        [
          "-e", CWD_GUARD,
          "-e", EMIT_SUMMARY,
          "--mode", "json",
          "--tools", `${RECON_VERBS},emit_summary`,
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
          env: {
            ...process.env,
            PI_SANDBOX_ROOT: sandboxRoot,
            PI_SANDBOX_VERBS: RECON_VERBS,
          },
        },
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
          if (e.type === "tool_execution_start" && e.toolName === "emit_summary") {
            toolCalls++;
            const a = e.args as Record<string, unknown> | undefined;
            const title = typeof a?.title === "string" ? a.title : "";
            const body = typeof a?.body === "string" ? a.body : "";
            if (title && body) {
              summaries.push({ title, body });
              ctx.ui.notify(`Recon → emit_summary "${title}" (${Buffer.byteLength(body, "utf8")} bytes)`, "info");
            }
          } else if (e.type === "tool_execution_start") {
            toolCalls++;
            ctx.ui.notify(`Recon → ${e.toolName}`, "info");
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
      if (summaries.length === 0) {
        ctx.ui.notify(`Recon produced no emit_summary calls. Stderr: ${stderr.slice(-1000)}`, "error");
        return;
      }

      // Per-summary byte cap, then total-length cap on the concatenation.
      // TODO:VALIDATION — add task-specific checks here.
      const capped = summaries.map((s) => {
        const bytes = Buffer.byteLength(s.body, "utf8");
        const body = bytes > SUMMARY_BYTE_CAP ? s.body.slice(0, SUMMARY_BYTE_CAP) + "\n…(truncated)" : s.body;
        return `## ${s.title}\n\n${body}`;
      });
      let combined = capped.join("\n\n---\n\n");
      if (Buffer.byteLength(combined, "utf8") > TOTAL_BYTE_CAP) {
        combined = combined.slice(0, TOTAL_BYTE_CAP) + "\n…(truncated)";
      }

      const outDir = path.resolve(sandboxRoot, ".pi/scratch");
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, "TODO:CMD_NAME-summary.md");
      fs.writeFileSync(outPath, combined, "utf8");
      ctx.ui.notify(
        `Recon complete (${toolCalls} tool call(s), ${summaries.length} summary/summaries, ${Buffer.byteLength(combined, "utf8")} bytes). Summary: ${outPath}`,
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
- BOTH `-e <abs path ending in components/cwd-guard.ts>` AND
  `-e <abs path ending in components/emit-summary.ts>` on the spawn
  args. Resolve paths relative to the parent extension's own
  `import.meta.url`, NOT from `$HOME` or cwd.
- `"--tools", "sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob,emit_summary"`
  — sandbox read verbs plus the emit stub. No built-in
  `read`/`ls`/`grep`/`glob`/`write`/`edit`, no `stage_write`, no
  `sandbox_write`, no `sandbox_edit`, no `bash`.
- Child env includes `PI_SANDBOX_ROOT: sandboxRoot` AND
  `PI_SANDBOX_VERBS: "sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob"`
  (the read-only subset; cwd-guard registers no write tools).
- `"--no-extensions"` on the spawn args.
- NDJSON parser matches on
  `e.type === "tool_execution_start" && e.toolName === "emit_summary"`
  and reads `title` / `body` from `e.args`. The parent must NOT
  rely on `message_end` assistant text for the summary content.
- `setTimeout(…, PHASE_TIMEOUT_MS)` + `child.kill("SIGKILL")` — hard
  timeout.
- Per-summary cap: `Buffer.byteLength(body, "utf8") > SUMMARY_BYTE_CAP`
  (or `.slice(0, SUMMARY_BYTE_CAP)` on each body).
- `fs.writeFileSync(outPath, combined, "utf8")` — parent writes the
  summary (not the child). Path scoped to `.pi/scratch/`.
- NO `-e <…stage-write…>`. Recon's only output channel is `emit_summary`.
- NO `ctx.ui.confirm` call. Recon has no side effect to gate.
