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

## Parent-side wiring template

`cwd-guard` is a **negative wiring case** — there's no parent
harvest, because the child writes directly via `sandbox_write` /
`sandbox_edit` (cwd-guard's own `execute` handles the
`fs.writeFileSync` inside the child process, after validating the
path).

- **Event anchor:** none (no parent harvest of a stub call).
- **Args destructuring:** none.
- **State shape:** the parent does not accumulate writes from
  cwd-guard. If you need to know what was written, list the
  sandbox cwd after the child closes.
- **Finalize behavior:** none beyond the standard close-event
  cleanup (`clearTimeout`, cost aggregation, exit-code check).

### Spawn snippet

```ts
const child = spawn(
  "pi",
  [
    "-e", CWD_GUARD,
    "--tools", "read,sandbox_write,sandbox_edit,ls,grep",
    "--no-extensions",
    "--mode", "json",
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
```

`stdio: ["ignore", "pipe", "pipe"]` is mandatory — pi blocks
reading stdin when it's a pipe even with `-p`, so we feed the
prompt via argv and close stdin.
