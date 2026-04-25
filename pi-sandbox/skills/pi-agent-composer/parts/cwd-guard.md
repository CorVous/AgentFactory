# Component: `cwd-guard.ts`

**Location:** `pi-sandbox/.pi/components/cwd-guard.ts`

## What it does

The cwd-policy component. After the policy/surface split, cwd-guard
owns three things:

1. **The `validate(p, root)` helper.** Lex + realpath check that `p`
   resolves inside `root`. Throws on escape (including symlink
   escapes). Exported for any privileged component (sandbox-fs,
   stage-write, emit-agent-spec) that does its own fs work to call
   before any `fs.*` syscall.
2. **The `PI_SANDBOX_ROOT` env contract.** The parentSide sets it
   from the spawn cwd; the child-side default-export asserts it's
   present and fails fast otherwise.
3. **Runtime path-arg auditing.** The default-export attaches
   `pi.on("tool_call")` and walks args for absolute-path strings,
   running `validate()` on each. Catches out-of-cwd paths passed to
   *any* registered tool, including future role components that take
   a path arg without remembering to call `validate()` themselves.

cwd-guard registers ZERO LLM-visible tools. The actual `sandbox_*`
verb surface lives in `sandbox-fs.ts` (see `parts/sandbox-fs.md`).

## Auto-injection

cwd-guard is the only entry in `pi-sandbox/.pi/lib/policies.ts`'s
`POLICIES` registry today. `delegate()` and the YAML runner walk
`POLICIES` and prepend each entry's parentSide to every spawn's
component list automatically. **You never list `cwd-guard` in a
phase's `components:` array — the runner rejects it with an
"auto-injected; do not list" error.**

The defense-in-depth rule "every spawn loads cwd-guard, no
exceptions" is now enforced by code, not by convention. Even
no-fs roles (RPC delegators with only `run_deferred_writer,review`)
get the auditor handler attached, so a bad path arg passed to any
stub tool is rejected at runtime.

## When to compose

- **Don't list it.** Auto-injected. Listing it in a phase's
  `components:` is a validation error.
- **Don't reference it from a YAML spec at all.** `tools` controls
  whether sandbox-fs is auto-injected (any `sandbox_*` token activates
  it); `components` lists role-specific stubs (`stage-write`,
  `emit-summary`, etc).

## Required `--tools` allowlist contribution

None. cwd-guard registers no LLM-visible tools.

## Required env contribution

- `PI_SANDBOX_ROOT` — set automatically by cwd-guard's parentSide
  (`env: ({cwd}) => ({ PI_SANDBOX_ROOT: cwd })`). The auto-injector
  merges this into every child env. You don't set it manually for
  delegate-driven spawns.

## Parent-side wiring

The auto-injector handles it. For hand-rolled spawns that bypass
`delegate()` (e.g. `delegated-writer.ts:DelegatorSession`,
`safe-drafter.ts`, the orchestrator's drafter), import the
singleton:

```ts
import { cwdGuardSide } from "../components/cwd-guard.ts";

const spawnArgs = [...cwdGuardSide.spawnArgs, /* others */];
const env = { ...process.env, ...cwdGuardSide.env({ cwd: sandboxRoot }) };
```

For composer-emitted YAML specs, do nothing — the runner injects.

## Validate() helper

Privileged components that need `node:fs` (sandbox-fs.ts,
stage-write.ts, emit-agent-spec.ts) import `validate` from
cwd-guard and call it on every absolute path before the `fs.*`
call:

```ts
import { validate } from "./cwd-guard.ts";
// ...
const dest = path.resolve(sandboxRoot, relPath);
validate(dest, sandboxRoot);  // throws on escape
fs.writeFileSync(dest, content, "utf8");
```

See `parts/sandbox-fs.md` for the canonical six-tool example;
`AGENTS.md` "Authoring a new component" describes the pattern in
detail.

## Auditor blocking semantics

The `pi.on("tool_call")` handler returns `{ block: true, reason }`
to abort a tool call. The two block conditions:

1. **Tool name doesn't match the allowed-prefix set.** Allowed:
   `sandbox_*`, `stage_*`, `emit_*`, `run_*`, `review`. Anything
   else (e.g. a hypothetical `exec_shell`) is blocked at the
   tool_call event before the body runs.
2. **An absolute-path arg escapes `PI_SANDBOX_ROOT`.** Walks args
   recursively; for each string starting with `/`, calls
   `validate()`. The first violation aborts the call.

This is defense-in-depth. The primary enforcement for sandbox tool
calls is sandbox-fs's per-body `validate()`. The auditor backstops
that and covers role-component tools whose authors might forget to
validate themselves.
