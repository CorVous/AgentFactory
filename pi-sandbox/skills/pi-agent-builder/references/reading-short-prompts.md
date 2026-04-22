# Reading short prompts

When the user gives a short natural-language description of what they want
(e.g. *"build a sub-agent that only has the ability to ls so it can choose
a spot to write, and only after the user confirms it…"*), your job is to
**infer** the right technical shape — not bounce it back asking for a spec.

## Process

1. Quote the user's prompt back to yourself.
2. Scan it against the signal table below. Each matched phrase *requires*
   the listed rail — include it even if the user didn't spell it out.
3. Apply every rail in `defaults.md` on top of the signal-driven ones.
4. Now check for **residual** ambiguity — things the table and defaults
   can't resolve on their own. Ask about those only.

## Signal → rail

| If the prompt says (or implies)… | You must include… |
| --- | --- |
| "a sub-agent" / "delegate" / "spawn a child" | `--no-extensions` on child; `AbortSignal` forwarded into `spawn`; stdout truncated to ~20 KB in the tool result; `--model` from the tier env vars |
| "only has the ability to X" / "restricted to X" / "can only X" | Child gets `--tools X` allowlist *and nothing else* |
| "read-only" / "survey" / "recon" / "explore" | Child gets `--tools read,grep,glob,ls` (narrower if the prompt says so) |
| "after the user confirms" / "with approval" / "the user decides" | `ctx.ui.confirm(title, preview)` gate before the side effect; return early on `undefined`/`false` |
| "not able to overwrite" / "can't modify other files" / "new file only" | Pre-check `!fs.existsSync(path)`; after the write, verify `sha256(fs.readFileSync(path)) === expectedHash` |
| "buffered" / "staged" / "let it try to write but don't actually write yet" / "show me what it would do, then write on approval" | Spawn the agent with `cwd: fs.mkdtempSync(...)` (throwaway staging dir) and give it a real `write` tool. Any relative path it writes lands in staging, not the project. After the child exits, enumerate the staging tree, sandbox-check each path against the real project root, show previews in `ctx.ui.confirm`, and `fs.copyFileSync` promotions only on approval. Cleanup the staging dir in `finally`. Tell the agent in its prompt that absolute writes won't be promoted, and that it should read real files via absolute paths under the project root |
| "can't get outside X" / "stays inside X" / "sandboxed to X" / "scoped to this directory" | Capture `sandboxRoot = path.resolve(process.cwd())` (or whatever X resolves to) at handler entry; reject any proposed path whose resolved form doesn't satisfy `abs === sandboxRoot \|\| abs.startsWith(sandboxRoot + path.sep)`; also spawn writer children with `cwd: sandboxRoot` |
| "decide what it wants to write first" / "plan before acting" / "propose" | Phase 1 returns *structured* output (JSON inside `===PLAN===` … `===ENDPLAN===` fences) with every field the later phase needs (path + full content, not just a path). Prefer ASCII fences over `<…>` tags — some renderers strip angle brackets and break parsing |
| "two phases" / "first X, then Y" / "propose … then commit" | Separate child `pi` processes per phase, each with its own tool allowlist |
| "in parallel" / "fan out" / "N tasks at once" | `Promise.all` over the children; tag each result with its task index so the parent can correlate |
| "slash command" / "/<name>" / "user types" | `pi.registerCommand(name, { handler })` — not `registerTool` |
| "the LLM should call" / "the agent decides to use" | `pi.registerTool(spec)` — not `registerCommand` |
| "cancellable" / "user can abort" | Wire the `signal` from `execute` (or the command's own `AbortController`) through every `spawn`, `fetch`, and long-running await |

If the prompt contains a phrase not in this table, fall back to the
matching recipe file (tool / command / events / subagent) and still apply
`defaults.md`.

## Worked example

User prompt (verbatim):

> can you have pi write a sub agent that is invoked with /deferred-writer
> that spawns a subagent that only has the ability to ls so it can choose
> a spot to write, and only after the user confirms it, it then is able to
> write and not able to overwrite any other file? Also it should decide
> what it wants to write first.

Signals extracted:

- *"invoked with /deferred-writer"* → `pi.registerCommand("deferred-writer", …)`.
- *"spawns a subagent"* → child `pi` process; apply every sub-agent rail
  from `defaults.md`.
- *"only has the ability to ls"* → phase 1 child: `--tools ls`.
- *"only after the user confirms it"* → `ctx.ui.confirm` between phases;
  build a preview of what's about to be written.
- *"not able to overwrite any other file"* → pre-check existence; post-check
  sha256 of the written file.
- *"decide what it wants to write first"* → phase 1 returns *path and full
  content*, not just a path. Phase 2 commits verbatim.
- Implicit (from *"then is able to write"*): phase 2 child gets `--tools write`.

Resulting structure without further questions: a single-agent command
with staging-dir buffering — spawn the drafter with `cwd` pinned to a
fresh `fs.mkdtempSync` directory and give it the real `write` tool;
after it exits, enumerate the staging tree, sandbox-check each
destination against the project root, preview in `ctx.ui.confirm`, then
`copyFileSync` on approval. This is cleaner than a planner→writer
handshake because the agent uses its native `write` naturally and
multi-file drafts work out of the box.

Apply every always-on rail from `defaults.md` on top — in particular the
`stdio: "ignore"` stdin fix, `setTimeout`+`SIGKILL` child timeout,
progress `notify` calls at every tool-call boundary, the sandbox-root
path check, and the `finally`-block cleanup of the staging dir even
though the prompt didn't call any of them out by name. A real
implementation is committed at `.pi/extensions/deferred-writer.ts` in
the AgentFactory repo.

## When to still ask

Only if a signal is *missing* that changes the shape materially — e.g.
the prompt says "write a file" but doesn't imply confirmation or
overwrite policy, and the task is destructive enough that guessing the
wrong default would hurt. Ask narrowly, with the default you'd pick if
the user shrugs.
