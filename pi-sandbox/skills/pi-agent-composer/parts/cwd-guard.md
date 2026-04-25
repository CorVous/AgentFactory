# Component: `cwd-guard.ts`

**Location:** `pi-sandbox/.pi/components/cwd-guard.ts`

## What it does

Pi extension that owns the entire cwd-safe filesystem surface.
Registers path-validated equivalents for every fs-touching built-in:

| Sandbox verb | Replaces | Validation |
| --- | --- | --- |
| `sandbox_read`  | `read`  | path under `PI_SANDBOX_ROOT` (lex + realpath) |
| `sandbox_ls`    | `ls`    | path under `PI_SANDBOX_ROOT` |
| `sandbox_grep`  | `grep`  | search root under root; results filtered |
| `sandbox_glob`  | `glob`  | pattern resolves under root; matches filtered |
| `sandbox_write` | `write` | path under `PI_SANDBOX_ROOT` |
| `sandbox_edit`  | `edit`  | path under `PI_SANDBOX_ROOT` |

Both lex and realpath checks fire, so symlink-based escapes are
caught even when a harness mounts directories into the cwd via
`ln -s`.

The pi built-ins `read`/`ls`/`grep`/`glob`/`write`/`edit` and `bash`
are **forbidden** project-wide (the runtime delegate() rejects any
spawn whose `--tools` CSV includes them). cwd-guard is the only
sanctioned fs surface.

## When to use

**Always. On every sub-pi spawn, no exceptions.** Recon, drafter,
confined-drafter — every fs-capable role loads cwd-guard with its
verb subset. *No-fs* roles (an RPC delegator whose only tools are
`run_deferred_writer,review`, for example) ALSO load cwd-guard,
with an empty verb list — cwd-guard registers zero sandbox tools
in that case but its `-e` is on the argv anyway. The benefit is
defense-in-depth and a uniform mental model: every child has the
guard, so adding fs to a previously no-fs role only requires
updating `tools` + `PI_SANDBOX_VERBS`, never "remember to also
add `-e cwd-guard.ts`."

## Selective registration

cwd-guard reads `PI_SANDBOX_VERBS` (comma-separated) and registers
**only** the verbs listed. A recon child sees only read verbs; a
drafter-with-approval child sees only `sandbox_ls` (writes go via
`stage_write`); a confined-drafter sees the read verbs plus
`sandbox_write`/`sandbox_edit`. Verbs the role didn't ask for don't
exist in the child process at all — they can't be registered, can't
appear in `tool_execution_start` events, can't be smuggled past the
allowlist.

## Load mechanism

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

const CWD_GUARD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components",
  "cwd-guard.ts",
);
```

Pass as `-e <CWD_GUARD>` in the child's spawn args. Compute the
path from the parent extension's own file location so the layout
ships with the project and doesn't depend on `$HOME` or the user's
cwd.

## Required `--tools` allowlist contribution

Pick the subset the role needs:

| Role | Verbs |
| --- | --- |
| Recon | `sandbox_read,sandbox_ls,sandbox_grep,sandbox_glob` |
| Drafter-with-approval | `sandbox_ls` (or `sandbox_ls,sandbox_read`) |
| Confined-drafter | `sandbox_read,sandbox_write,sandbox_edit,sandbox_ls,sandbox_grep` |
| RPC delegator (no-fs) | (empty — `verbs: []`) |

Plus the role-specific stub (`stage_write`, `emit_summary`,
`run_deferred_writer`, `review`, etc). Do NOT include any built-in
fs verb or `bash` — those are forbidden.

## Required env contribution

- `PI_SANDBOX_ROOT` — absolute path; cwd-guard validates every
  operation against it. Always required.
- `PI_SANDBOX_VERBS` — comma-separated subset of the six sandbox
  verbs. cwd-guard registers only these. May be empty (or unset)
  for no-fs roles — cwd-guard then loads and registers nothing.
  The factory `makeCwdGuard({verbs: [...]})` always sets both env
  vars; in the no-fs case it sets `PI_SANDBOX_VERBS=""`.

## Parent-side wiring (factory)

```ts
import { makeCwdGuard } from "../components/cwd-guard.ts";
import { delegate } from "../lib/delegate.ts";

// Drafter-with-approval: read-only, stage_write is the write channel.
const CWD_GUARD = makeCwdGuard({ verbs: ["sandbox_read", "sandbox_ls"] });
await delegate(ctx, { components: [CWD_GUARD, STAGE_WRITE], prompt });

// Confined-drafter: real writes, sandboxed.
const CWD_GUARD_FULL = makeCwdGuard({
  verbs: ["sandbox_read", "sandbox_ls", "sandbox_grep",
          "sandbox_write", "sandbox_edit"],
});
await delegate(ctx, { components: [CWD_GUARD_FULL], prompt });

// Recon: read-only.
const CWD_GUARD_RECON = makeCwdGuard({
  verbs: ["sandbox_read", "sandbox_ls", "sandbox_grep", "sandbox_glob"],
});
await delegate(ctx, { components: [CWD_GUARD_RECON, EMIT_SUMMARY], prompt });

// No-fs role (RPC delegator): cwd-guard loads but registers nothing.
const CWD_GUARD_NONE = makeCwdGuard({ verbs: [] });
// (delegator typically goes through a hand-rolled spawn rather than
// delegate(); see `delegated-writer.ts:DelegatorSession` for the shape.)
```

`makeCwdGuard()` returns a `ParentSide` whose `tools` array matches
the requested verbs exactly, whose `spawnArgs` carry the `-e` flag,
and whose `env(ctx)` sets both `PI_SANDBOX_ROOT` and
`PI_SANDBOX_VERBS`. cwd-guard is a **negative wiring case** for
harvest — the child's sandbox tools execute directly inside the
child process (sandbox_write/edit write to disk, sandbox_read/ls/grep/glob
return data inline), so `parentSide.harvest` is a no-op and
`parentSide.finalize` returns `{}`.

See `_parent-side.ts` for the exact `ParentSide` shape.
