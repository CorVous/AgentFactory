# Component: `cwd-guard.ts`

**Location:** `pi-sandbox/.pi/components/cwd-guard.ts`

## What it does

Pi extension that registers two tools — `sandbox_write` and
`sandbox_edit` — which validate every write/edit target against
`$PI_SANDBOX_ROOT`. Both reject absolute paths and `..` segments
that resolve outside the root.

## When to use

**Always, on every write-capable sub-pi spawn.** The child's
`--tools` allowlist should include `sandbox_write,sandbox_edit`
and exclude the built-in `write` / `edit`, so the only write path
out of the child is validated.

Exception: a read-only child whose only output channel is
`emit_summary` (no filesystem contact, no write verbs in the
allowlist). The recon-style single-spawn topology takes that
exception.

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

```
sandbox_write,sandbox_edit
```

Plus any read-only verbs the child role needs (`ls`, `read`,
`grep`, `glob`). Do NOT include `write`, `edit`, or `bash` — those
defeat the sandbox.

## Required env contribution

`PI_SANDBOX_ROOT` MUST be set to an absolute path in the child's
env (typically the parent's `process.cwd()`). cwd-guard throws at
load time if the env var is missing.

## Parent-side wiring

Adds `cwd-guard.parentSide` to the `delegate()` call's
`components` array. `delegate()` unions `parentSide.tools`
(`read, sandbox_write, sandbox_edit, ls, grep`), pushes
`-e <cwd-guard.ts>` into the child argv, and sets
`PI_SANDBOX_ROOT: <cwd>` on the child env. cwd-guard is a
**negative wiring case** for harvest — the child's
`sandbox_write` / `sandbox_edit` write directly via their own
`execute` (inside the child process, after path-validating
against `PI_SANDBOX_ROOT`), so `parentSide.harvest` is a no-op
and `parentSide.finalize` returns `{}`.

```ts
import { parentSide as CWD_GUARD } from "../components/cwd-guard.ts";
import { delegate } from "../lib/delegate.ts";

await delegate(ctx, { components: [CWD_GUARD], prompt });
// confined-drafter shape; pair with STAGE_WRITE for drafter-with-approval.
```

See `_parent-side.ts` for the exact `ParentSide` shape.
