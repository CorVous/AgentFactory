# Pattern: `confined-drafter`

**When to use:** user wants the agent to write files into a scoped
directory with no human approval gate. The child is trusted to
write, but only inside `$PI_SANDBOX_ROOT` — cwd-guard enforces the
boundary. This is the right shape for batch, scripted, or
non-interactive runs (e.g. `agent-maker.sh` generating extensions).

## Short-prompt signals that match

- "write X into `<dir>`"
- "generate a project at `<path>`"
- "create the files — just do it"
- "no approval needed", "scripted", "batch", "one-shot"
- `-p` / non-interactive invocation where `ctx.ui.confirm` would
  unconditionally return `false`

## Parts

1. `cwd-guard.ts` — universal cwd policy. Sets `PI_SANDBOX_ROOT`,
   exports `validate()`, attaches the tool_call auditor. Required
   on every sub-pi spawn.
2. `sandbox-fs.ts` — registers `sandbox_write` / `sandbox_edit` /
   `sandbox_read` / `sandbox_ls` / `sandbox_grep`, all
   path-validated against `$PI_SANDBOX_ROOT` via cwd-guard's
   exported `validate()`.

That's the whole parts list. No staging, no review.

## `--tools` allowlist on the child

```
sandbox_read,sandbox_write,sandbox_edit,sandbox_ls,sandbox_grep
```

`sandbox_glob` is a reasonable addition if the drafter needs to
search the existing tree. Never include built-in `read`, `ls`,
`grep`, `glob`, `write`, `edit`, or `bash` — those are forbidden
across the project; only the path-validated `sandbox_*` family is
allowed.

## Model tier

`$TASK_MODEL` for bulk drafting. Escalate to `$LEAD_MODEL` only if
the task is orchestration-heavy (in which case the `orchestrator`
pattern is probably the better fit).

## Why no approval gate

`ctx.ui.confirm` returns `false` unconditionally in `-p` / print
mode (the `noOpUIContext` in pi's runner). A confirm gate on a
scripted run means "always cancel," which is surprising and
useless. For interactive runs where human review matters, use
`drafter-with-approval` instead. This pattern is specifically for
the case where the gate would hurt.

## Canonical assembled example

`scripts/task-runner/agent-maker.sh` runs pi with the
`pi-agent-builder` (or this) skill in a per-run cwd, loading
cwd-guard as the sole `-e` argument and passing the narrow
allowlist above. Study that script for the parent-side plumbing —
specifically how it sets `PI_SANDBOX_ROOT` and rejects out-of-cwd
writes.

## Skeleton

Save this file as `.pi/extensions/<TODO:CMD_NAME>.ts` under the
project's sandbox directory. Files at the cwd root are NOT
auto-discovered by pi and won't register.

```ts
// .pi/extensions/TODO:CMD_NAME.ts — confined drafter, no approval gate.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 300_000; // longer than drafter-with-approval; no gate to collect at the end

const CWD_GUARD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "cwd-guard.ts",
);
const SANDBOX_FS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "sandbox-fs.ts",
);

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
      if (!fs.existsSync(CWD_GUARD) || !fs.existsSync(SANDBOX_FS)) {
        ctx.ui.notify(`cwd-guard or sandbox-fs missing under pi-sandbox/.pi/components/`, "error");
        return;
      }
      const sandboxRoot = path.resolve(process.cwd());

      const agentPrompt =
        `You are a DRAFTER confined to ${sandboxRoot}. Task: ${args}.\n\n` +
        `Use ONLY sandbox_write({path, content}) to create files and ` +
        `sandbox_edit({path, oldText, newText}) to modify them. Paths are ` +
        `relative to ${sandboxRoot} and must stay inside it. The built-in ` +
        `write/edit tools are disabled in this session. ` +
        `TODO:AGENT_PROMPT Reply DONE and stop.`;

      let writes = 0;
      const VERBS = "sandbox_read,sandbox_write,sandbox_edit,sandbox_ls,sandbox_grep";
      const child = spawn(
        "pi",
        [
          "-e", CWD_GUARD,
          "-e", SANDBOX_FS,
          "--mode", "json",
          "--tools", VERBS,
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
            PI_SANDBOX_VERBS: VERBS,
          },
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
          if (e.type === "tool_execution_start") {
            const name = e.toolName as string | undefined;
            if (name === "sandbox_write" || name === "sandbox_edit") {
              writes++;
              const a = e.args as { path?: unknown } | undefined;
              const p = typeof a?.path === "string" ? a.path : "<?>";
              ctx.ui.notify(`Drafter → ${name} ${p}`, "info");
            } else {
              ctx.ui.notify(`Drafter → ${name}`, "info");
            }
          }
        }
      });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      const code = await new Promise<number>((resolve) => {
        child.on("close", (c) => { clearTimeout(timer); resolve(c ?? 0); });
        child.on("error", () => { clearTimeout(timer); resolve(-1); });
      });

      if (timedOut) { ctx.ui.notify(`Drafter timed out after ${PHASE_TIMEOUT_MS / 1000}s.`, "error"); return; }
      if (code !== 0) { ctx.ui.notify(`Drafter exit ${code}. Stderr: ${stderr.slice(-2000)}`, "error"); return; }

      // TODO:VALIDATION — task-specific sanity check on the written tree
      // (e.g. required files exist, no stray files outside expected paths).
      // Default: just report write count.
      ctx.ui.notify(`Drafter finished: ${writes} file write(s) inside ${sandboxRoot}.`, "info");
    },
  });
}
```

## Validation checklist

- `-e CWD_GUARD` AND `-e SANDBOX_FS` both present on the spawn args.
- `PI_SANDBOX_ROOT: sandboxRoot` in child env.
- `"--tools", "sandbox_read,sandbox_write,sandbox_edit,sandbox_ls,sandbox_grep"`
  (`sandbox_glob` optional) — no built-in `read`/`ls`/`grep`/`glob`/`write`/`edit`,
  no `bash`, no `stage_write`.
- Child env includes `PI_SANDBOX_VERBS` listing the exact subset of
  sandbox verbs the allowlist uses, so sandbox-fs registers only those.
- `"--no-extensions"` and `"--no-session"`.
- `setTimeout(..., PHASE_TIMEOUT_MS)` + `child.kill("SIGKILL")`.
- `stdio: ["ignore", "pipe", "pipe"]`.
- NO `ctx.ui.confirm` call — this pattern has no gate by design.
- NO `fs.writeFileSync` in the parent — the child writes directly
  via `sandbox_write`.
