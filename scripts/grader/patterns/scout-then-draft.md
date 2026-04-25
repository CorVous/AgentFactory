# Pattern: `scout-then-draft`

**When to use:** user wants the agent to *first* survey an existing
thing (a directory, a codebase, a fixture) and *then* produce one
or more new files informed by what the survey found. Two sub-pi
spawns per handler invocation — a recon child followed by a drafter
child — with the parent assembling a handoff brief between them.

This is two existing patterns (`recon` + `drafter-with-approval`)
composed in a single extension. No delegator LLM, no revise loop —
the parent owns the handoff.

## Short-prompt signals that match

- "look at `<X>`, then write `<Y>`"
- "survey the project and add a `<Z>`"
- "given what's there, produce the missing `<W>`"
- "read the directory and generate a `README.md` summarizing it"
- "audit the tests, then scaffold the missing one"

## When NOT to use

- **Pure recon** (survey only, no draft): use `patterns/recon.md`.
- **Pure draft** (no survey phase): use
  `patterns/drafter-with-approval.md` or `patterns/confined-drafter.md`.
- **Multiple sub-tasks with LLM review:** use
  `patterns/orchestrator.md`.

If the prompt says "look at X, then write Y and Z in parallel"
that's still scout-then-draft — the drafter child can stage
multiple files in one run. If it says "and have an LLM review
each," that's orchestrator.

## Parts

Two phases; each phase uses the parts from its underlying pattern.

**Recon phase (child 1):**

1. `cwd-guard.ts` — universal cwd policy (auditor + `validate()`).
2. `sandbox-fs.ts` — supplies the path-validated read verbs
   (`sandbox_read`, `sandbox_ls`, `sandbox_grep`, `sandbox_glob`).
   `PI_SANDBOX_VERBS` lists only the read verbs, so sandbox-fs
   registers no write tool.
3. `emit-summary.ts` — the child emits one or more structured
   summaries; the parent harvests `{title, body}` from NDJSON.

**Drafter phase (child 2):**

1. `cwd-guard.ts` — universal cwd policy.
2. `sandbox-fs.ts` — supplies `sandbox_read` / `sandbox_ls` for the
   drafter's read needs. `PI_SANDBOX_VERBS` excludes the write verbs,
   so no `sandbox_write`/`sandbox_edit` is registered. `stage_write`
   is the only write channel.
3. `stage-write.ts` — the stub write channel. Parent previews via
   `ctx.ui.confirm` and promotes on approval.

## `--tools` allowlist

- **Recon child:** `sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob,emit_summary`
  — exactly the recon allowlist.
- **Drafter child:** `stage_write,sandbox_ls` (or
  `stage_write,sandbox_ls,sandbox_read` if the drafter needs to
  inspect additional files beyond what the recon brief conveys).

Nothing else in either. No built-in `read`/`ls`/`grep`/`glob`/`write`/`edit`,
no `bash`, and NO `sandbox_write`/`sandbox_edit` on either child.

## Model tiers

- **Recon child:** `$TASK_MODEL`.
- **Drafter child:** `$TASK_MODEL` by default. Upgrade to
  `$LEAD_MODEL` only if the drafter prompt explicitly needs
  "review" or "decide" judgment (e.g. "pick the right shape
  given the survey"). For most scout-then-draft prompts, both
  phases are bulk worker output.

## Handoff shape

The parent assembles the brief by concatenating each harvested
summary:

```
## <title-1>

<body-1>

---

## <title-2>

<body-2>
```

and prepending it to the drafter prompt:

```
<user task>

Context — survey findings:
<brief>
```

Apply the same per-body byte cap used in recon
(`SUMMARY_BYTE_CAP`) plus a total-brief cap so an over-chatty
recon can't blow up the drafter's prompt budget.

## Skeleton

Save this file as `.pi/extensions/<TODO:CMD_NAME>.ts` under the
project's sandbox directory. Files at the cwd root are NOT
auto-discovered by pi and won't register.

```ts
// .pi/extensions/TODO:CMD_NAME.ts — scout-then-draft: recon child feeds brief into drafter child.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RECON_TIMEOUT_MS = 120_000;
const DRAFTER_TIMEOUT_MS = 180_000;
const SUMMARY_BYTE_CAP = 8_000;
const BRIEF_TOTAL_BYTE_CAP = 32_000;
const MAX_FILES_PROMOTABLE = 50;
const MAX_CONTENT_BYTES_PER_FILE = 2_000_000;
const PREVIEW_LINES_PER_FILE = 20;

const CWD_GUARD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "cwd-guard.ts",
);
const SANDBOX_FS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "sandbox-fs.ts",
);
const STAGE_WRITE_TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "stage-write.ts",
);
const EMIT_SUMMARY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "emit-summary.ts",
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
      if (
        !fs.existsSync(EMIT_SUMMARY) ||
        !fs.existsSync(STAGE_WRITE_TOOL) ||
        !fs.existsSync(CWD_GUARD) ||
        !fs.existsSync(SANDBOX_FS)
      ) {
        ctx.ui.notify("components missing; check pi-sandbox/.pi/components/", "error");
        return;
      }
      const sandboxRoot = path.resolve(process.cwd());

      // ---- Phase 1: recon child ---------------------------------------
      const RECON_VERBS = "sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob";
      const reconPrompt =
        `You are a RECON AGENT. Survey ${sandboxRoot} (and subdirectories the ` +
        `user task references) and produce bounded summaries via emit_summary. ` +
        `Use only 'sandbox_ls', 'sandbox_read', 'sandbox_grep', 'sandbox_glob' ` +
        `(no write, no edit, no bash). ` +
        `Call emit_summary({title, body}) with body <= ${SUMMARY_BYTE_CAP} bytes ` +
        `per call. ` +
        `TODO:AGENT_PROMPT_RECON ` +
        `User goal (context only — do NOT write any files in this phase): ${args}. ` +
        `Reply DONE and stop.`;

      const summaries: Array<{ title: string; body: string }> = [];
      const reconChild = spawn(
        "pi",
        [
          "-e", CWD_GUARD,
          "-e", SANDBOX_FS,
          "-e", EMIT_SUMMARY,
          "--mode", "json",
          "--tools", `${RECON_VERBS},emit_summary`,
          "--no-extensions",
          "--provider", "openrouter",
          "--model", MODEL,
          "--no-session",
          "--thinking", "off",
          "-p", reconPrompt,
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

      let reconBuffer = "";
      let reconStderr = "";
      let reconTimedOut = false;
      const reconTimer = setTimeout(() => { reconTimedOut = true; reconChild.kill("SIGKILL"); }, RECON_TIMEOUT_MS);

      reconChild.stdout.on("data", (d) => {
        reconBuffer += d.toString();
        const lines = reconBuffer.split("\n");
        reconBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let e: Record<string, unknown>;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.type === "tool_execution_start" && e.toolName === "emit_summary") {
            const a = e.args as Record<string, unknown> | undefined;
            const title = typeof a?.title === "string" ? a.title : "";
            const body = typeof a?.body === "string" ? a.body : "";
            if (title && body) {
              summaries.push({ title, body });
              ctx.ui.notify(`Scout → emit_summary "${title}" (${Buffer.byteLength(body, "utf8")} bytes)`, "info");
            }
          } else if (e.type === "tool_execution_start") {
            ctx.ui.notify(`Scout → ${e.toolName}`, "info");
          }
        }
      });
      reconChild.stderr.on("data", (d) => { reconStderr += d.toString(); });

      await new Promise<void>((resolve) => {
        reconChild.on("close", () => { clearTimeout(reconTimer); resolve(); });
        reconChild.on("error", () => { clearTimeout(reconTimer); resolve(); });
      });

      if (reconTimedOut) {
        ctx.ui.notify(`Scout timed out; no draft produced.`, "error");
        return;
      }
      if (summaries.length === 0) {
        ctx.ui.notify(`Scout produced no emit_summary calls. Stderr: ${reconStderr.slice(-1000)}`, "error");
        return;
      }

      // Assemble handoff brief. Per-summary cap + total-brief cap.
      const capped = summaries.map((s) => {
        const bytes = Buffer.byteLength(s.body, "utf8");
        const body = bytes > SUMMARY_BYTE_CAP ? s.body.slice(0, SUMMARY_BYTE_CAP) + "\n…(truncated)" : s.body;
        return `## ${s.title}\n\n${body}`;
      });
      let brief = capped.join("\n\n---\n\n");
      if (Buffer.byteLength(brief, "utf8") > BRIEF_TOTAL_BYTE_CAP) {
        brief = brief.slice(0, BRIEF_TOTAL_BYTE_CAP) + "\n…(truncated)";
      }

      // ---- Phase 2: drafter child -------------------------------------
      const drafterPrompt =
        `You are a DRAFTER. Task: ${args}.\n\n` +
        `Context — survey findings from the recon phase:\n${brief}\n\n` +
        `Nothing you do will touch disk until the user approves. Call ` +
        `stage_write({path, content}) with a RELATIVE path inside ${sandboxRoot} ` +
        `and the full content. Do NOT call any write/edit tool. ` +
        `TODO:AGENT_PROMPT_DRAFTER Reply DONE and stop.`;

      const stagedWrites: Array<{ path: unknown; content: unknown }> = [];
      const DRAFTER_VERBS = "sandbox_ls";
      const drafterChild = spawn(
        "pi",
        [
          "-e", CWD_GUARD,
          "-e", SANDBOX_FS,
          "-e", STAGE_WRITE_TOOL,
          "--mode", "json",
          "--tools", `stage_write,${DRAFTER_VERBS}`,
          "--no-extensions",
          "--provider", "openrouter",
          "--model", MODEL,
          "--no-session",
          "--thinking", "off",
          "-p", drafterPrompt,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: sandboxRoot,
          env: {
            ...process.env,
            PI_SANDBOX_ROOT: sandboxRoot,
            PI_SANDBOX_VERBS: DRAFTER_VERBS,
          },
        },
      );

      let drafterBuffer = "";
      let drafterStderr = "";
      let drafterTimedOut = false;
      const drafterTimer = setTimeout(() => { drafterTimedOut = true; drafterChild.kill("SIGKILL"); }, DRAFTER_TIMEOUT_MS);

      drafterChild.stdout.on("data", (d) => {
        drafterBuffer += d.toString();
        const lines = drafterBuffer.split("\n");
        drafterBuffer = lines.pop() ?? "";
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
      drafterChild.stderr.on("data", (d) => { drafterStderr += d.toString(); });

      const drafterExit = await new Promise<number>((resolve) => {
        drafterChild.on("close", (c) => { clearTimeout(drafterTimer); resolve(c ?? 0); });
        drafterChild.on("error", () => { clearTimeout(drafterTimer); resolve(-1); });
      });

      if (drafterTimedOut) { ctx.ui.notify(`Drafter timed out; drafts discarded.`, "error"); return; }
      if (drafterExit !== 0) { ctx.ui.notify(`Drafter exit ${drafterExit}. Stderr: ${drafterStderr.slice(-2000)}`, "error"); return; }
      if (stagedWrites.length === 0) { ctx.ui.notify("Drafter made no stage_write calls.", "warning"); return; }
      if (stagedWrites.length > MAX_FILES_PROMOTABLE) {
        ctx.ui.notify(`Drafter staged ${stagedWrites.length} files (> ${MAX_FILES_PROMOTABLE}); aborting.`, "error");
        return;
      }

      // Validation + preview + promotion: identical shape to
      // drafter-with-approval. See that pattern's skeleton for the full
      // per-draft validation (absolute-path reject, '..' reject,
      // exists-skip, byte-length cap) and sha256-verified promotion.
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

      // TODO:VALIDATION — optional task-specific post-drafter checks.

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

Two phases means two sets of anchors plus a structural phase-count
anchor.

**Phase count:**

- Exactly **two** `spawn("pi"` calls in the handler body — the
  recon child first, the drafter child second. A single-spawn
  emit is the wrong pattern (pick `recon` or
  `drafter-with-approval`); a three-plus-spawn emit is the wrong
  pattern (pick `orchestrator`).

**Recon child (first spawn):**

- `-e <abs path ending in components/cwd-guard.ts>` AND
  `-e <abs path ending in components/sandbox-fs.ts>` AND
  `-e <abs path ending in components/emit-summary.ts>`.
- `"--tools", "sandbox_ls,sandbox_read,sandbox_grep,sandbox_glob,emit_summary"`.
- Child env: `PI_SANDBOX_ROOT: sandboxRoot` AND `PI_SANDBOX_VERBS`
  listing the read-only sandbox subset.
- `"--no-extensions"` and `"--no-session"`.
- NDJSON parser matches on
  `e.type === "tool_execution_start" && e.toolName === "emit_summary"`
  and reads `title`/`body` from `e.args`.
- `RECON_TIMEOUT_MS` + `child.kill("SIGKILL")`.
- Per-summary byte cap (`Buffer.byteLength` or `.slice(0, N)`).

**Drafter child (second spawn):**

- `-e <abs path ending in components/cwd-guard.ts>` AND
  `-e <abs path ending in components/sandbox-fs.ts>` AND
  `-e <abs path ending in components/stage-write.ts>`.
- `PI_SANDBOX_ROOT: sandboxRoot` AND `PI_SANDBOX_VERBS: "sandbox_ls"`
  (or `"sandbox_ls,sandbox_read"` if justified) in the child env.
  NO write verbs — `stage_write` is the only write channel.
- `"--tools", "stage_write,sandbox_ls"` (or `,sandbox_ls,sandbox_read`
  if justified).
- `"--no-extensions"` and `"--no-session"`.
- NDJSON parser matches on
  `e.toolName === "stage_write"` and reads `path`/`content` from
  `e.args`.
- `DRAFTER_TIMEOUT_MS` + SIGKILL.
- `stagedWrites.length > MAX_FILES_PROMOTABLE` cap.
- Per-file byte-length cap.
- Path validation rejects absolute paths and `..` segments.
- `ctx.ui.confirm(...)` before any `fs.writeFileSync`.
- sha256 verification after write.
- Cancel path (`ok === false`) exits cleanly with a notify.

**Handoff:**

- The drafter prompt includes the recon brief (e.g. via a
  `Context — survey findings:` or similar marker) built from the
  harvested summaries. The brief is NOT passed via env vars or
  argv beyond the prompt itself.
- A total-brief byte cap (`BRIEF_TOTAL_BYTE_CAP` or equivalent)
  protects the drafter prompt from an over-chatty recon.
