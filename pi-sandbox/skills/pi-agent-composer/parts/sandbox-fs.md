# Component: `sandbox-fs.ts`

**Location:** `pi-sandbox/.pi/components/sandbox-fs.ts`

## What it does

The path-validated fs tool surface. Registers sandbox equivalents for
every fs-touching built-in pi tool:

| Sandbox verb | Replaces | Validation |
| --- | --- | --- |
| `sandbox_read`  | `read`  | path under `PI_SANDBOX_ROOT` (lex + realpath) |
| `sandbox_ls`    | `ls`    | path under `PI_SANDBOX_ROOT` |
| `sandbox_grep`  | `grep`  | search root under root; results filtered |
| `sandbox_glob`  | `glob`  | pattern resolves under root; matches filtered |
| `sandbox_write` | `write` | path under `PI_SANDBOX_ROOT` |
| `sandbox_edit`  | `edit`  | path under `PI_SANDBOX_ROOT` |

Each tool body imports `validate(p, root)` from `cwd-guard.ts` and
calls it as the first line of its `execute()`. Both lex and realpath
checks fire, so symlink-based escapes are caught.

The pi built-ins `read`/`ls`/`grep`/`glob`/`write`/`edit` and `bash`
are **forbidden** project-wide (delegate() rejects any spawn whose
`--tools` CSV includes them). sandbox-fs is the only sanctioned fs
surface.

## Auto-injection

sandbox-fs is the only entry in
`pi-sandbox/.pi/lib/tool-providers.ts`'s `TOOL_PROVIDERS` registry
today. The auto-injector activates it iff the spawn's `--tools`
allowlist contains at least one `sandbox_*` token. The activated
parentSide registers exactly the requested verb subset (intersection
of `--tools` with the six sandbox verbs).

**You never list `sandbox-fs` in a phase's `components:` array.**
Like cwd-guard, it's auto-injected; the runner rejects the name
with an "auto-injected; do not list" error.

## When to compose

- **Don't list it.** Auto-injected based on the phase's `tools`.
- **Drive activation via `tools`.** Put the verbs your role needs
  (`sandbox_read`, `sandbox_ls`, etc.) in the phase's `tools` list;
  the runner activates sandbox-fs and tells it which verbs to
  register.

## Selective registration

sandbox-fs registers **only** the verbs requested. A recon child
sees only read verbs; a drafter-with-approval child sees only
`sandbox_ls` (writes go via `stage_write`); a confined-drafter
sees the read verbs plus `sandbox_write`/`sandbox_edit`. Verbs
the role didn't ask for are never registered — they can't appear
in `tool_execution_start` events, can't be smuggled past the
allowlist.

## Required `--tools` allowlist contribution

Pick the subset the role needs:

| Role | Verbs |
| --- | --- |
| Recon | `sandbox_read,sandbox_ls,sandbox_grep,sandbox_glob` |
| Drafter-with-approval | `sandbox_ls` (or `sandbox_ls,sandbox_read`) |
| Confined-drafter | `sandbox_read,sandbox_write,sandbox_edit,sandbox_ls,sandbox_grep` |
| RPC delegator (no-fs) | (no sandbox verbs → sandbox-fs not activated) |

Plus the role-specific stub (`stage_write`, `emit_summary`,
`run_deferred_writer`, `review`, etc).

## Required env contribution

- `PI_SANDBOX_VERBS` — comma-separated list of the requested verbs.
  Set automatically by the activated parentSide. Hand-rolled spawns
  set it manually.
- `PI_SANDBOX_ROOT` — set by cwd-guard's parentSide (universal).
  sandbox-fs reads it to anchor `validate()` calls.

## Parent-side wiring

The auto-injector handles it. For hand-rolled spawns that bypass
`delegate()` and need fs verbs (e.g. `safe-drafter.ts`, the
orchestrator's drafter), load both `cwd-guard.ts` AND
`sandbox-fs.ts` via `-e`:

```ts
import { cwdGuardSide } from "../components/cwd-guard.ts";
import { SANDBOX_FS_PATH, makeSandboxFs } from "../components/sandbox-fs.ts";

const sandboxFs = makeSandboxFs({ verbs: ["sandbox_ls", "sandbox_read"] });
const spawnArgs = [
  ...cwdGuardSide.spawnArgs,
  ...sandboxFs.spawnArgs,
  // ...role-specific stubs
];
const env = {
  ...process.env,
  ...cwdGuardSide.env({ cwd: sandboxRoot }),
  ...sandboxFs.env({ cwd: sandboxRoot }),
};
```

The `makeSandboxFs({verbs})` factory throws on empty verbs (no
point loading sandbox-fs without any tools to register).

## What sandbox-fs is NOT

- **Not the only path-validation site.** The cwd-guard auditor
  (also via `pi.on("tool_call")`) backstops sandbox-fs's per-body
  validate. Both fire; sandbox-fs's typed per-body check is the
  primary enforcement, the auditor's heuristic walk is
  defense-in-depth.
- **Not loaded for no-fs roles.** Delegators that only call
  `run_deferred_writer`/`review` get cwd-guard auto-injected (for
  the auditor) but NOT sandbox-fs (no sandbox verbs in `tools`).
