// pi-rails.ts — shared rails contract for direct-launch agent
// entry-point scripts (today: scripts/agent-composer.sh; tomorrow,
// any sibling that spawns pi as an agent without going through
// delegate() or the YAML runner).
//
// `delegate()` already auto-injects cwd-guard universally and
// sandbox-fs conditionally for spawns it manages
// (pi-sandbox/.pi/lib/auto-inject.ts). Direct-launch scripts bypass
// that path. This module exposes the same contract for them:
//
//   1. The --tools allowlist MUST exclude the built-in fs verbs
//      (read|ls|grep|glob|write|edit|bash). The agent's fs surface
//      is exclusively the sandbox_* family from sandbox-fs.ts plus
//      role-specific stubs (emit_agent_spec, stage_write, etc.).
//      `assertRailsCompatibleTools(toolsCsv)` enforces this.
//   2. Spawns MUST pass `-e <cwd-guard.ts>` (always) and
//      `-e <sandbox-fs.ts>` (when any sandbox_* verb appears in
//      tools), plus PI_SANDBOX_ROOT and PI_SANDBOX_VERBS in env.
//      `formatPiRailsFlags(sandboxAbs, verbs)` prints the argv
//      tokens; the env vars are emitted by `formatPiRailsEnv()`.
//
// The shape of this file is "data + assertions" — no I/O beyond
// stdout printing, so it stays trivially unit-testable. The
// FORBIDDEN_BUILTIN_VERBS set and SANDBOX_VERB_RE pattern mirror
// FORBIDDEN_TOOLS in pi-sandbox/.pi/lib/delegate.ts:48-51 so
// direct-launch and delegate-driven spawns enforce the same
// surface. If that list changes, update both files.
//
// Invocation from bash (see scripts/agent-composer.sh):
//   tsx scripts/lib/pi-rails.ts check  "$TOOLS"
//   tsx scripts/lib/pi-rails.ts argv   "$SANDBOX_ABS" "$VERBS_CSV"
//   tsx scripts/lib/pi-rails.ts env    "$SANDBOX_ABS" "$VERBS_CSV"

import * as path from "node:path";

/** Built-in fs/process verbs that escape the cwd-guard / sandbox-fs
 *  contract. Mirrors `FORBIDDEN_TOOLS` in delegate.ts. */
export const FORBIDDEN_BUILTIN_VERBS: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "grep",
  "glob",
  "write",
  "edit",
  "bash",
]);

/** Recognized sandbox_* verbs. Used to detect when sandbox-fs needs
 *  to be loaded into a spawn. Must stay in sync with `ALL_VERBS` in
 *  pi-sandbox/.pi/components/cwd-guard.ts. */
export const SANDBOX_VERBS: ReadonlySet<string> = new Set([
  "sandbox_read",
  "sandbox_ls",
  "sandbox_grep",
  "sandbox_glob",
  "sandbox_write",
  "sandbox_edit",
]);

/** Component file basenames the rails inject. Resolved against
 *  `<sandboxAbs>/.pi/components/`. */
const CWD_GUARD_BASENAME = "cwd-guard.ts";
const SANDBOX_FS_BASENAME = "sandbox-fs.ts";

export interface ParsedTools {
  /** Original tokens, trimmed, empty entries removed. */
  tokens: string[];
  /** Subset that matches a sandbox_* name. */
  sandboxVerbs: string[];
  /** Subset that hits FORBIDDEN_BUILTIN_VERBS — empty after assert. */
  forbidden: string[];
}

/** Parse a CSV `--tools` argument into the structured form the
 *  helpers below consume. Whitespace tolerant; empty entries are
 *  silently dropped. */
export function parseToolsCsv(csv: string): ParsedTools {
  const tokens = csv
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const sandboxVerbs: string[] = [];
  const forbidden: string[] = [];
  for (const tok of tokens) {
    if (FORBIDDEN_BUILTIN_VERBS.has(tok)) forbidden.push(tok);
    if (SANDBOX_VERBS.has(tok)) sandboxVerbs.push(tok);
  }
  return { tokens, sandboxVerbs, forbidden };
}

/** Throws if any forbidden built-in verb appears in `toolsCsv`.
 *  The error message names every offender so a misconfigured
 *  script gets a clear diagnostic instead of a silent escape. */
export function assertRailsCompatibleTools(toolsCsv: string): void {
  const parsed = parseToolsCsv(toolsCsv);
  if (parsed.forbidden.length > 0) {
    const verbs = parsed.forbidden.join(", ");
    throw new Error(
      `[pi-rails] --tools includes forbidden built-in verb(s): ${verbs}. ` +
        `Use the sandbox_* family from sandbox-fs.ts instead ` +
        `(e.g. sandbox_${parsed.forbidden[0]}). The built-in verbs ` +
        `bypass cwd-guard's path validation.`,
    );
  }
}

/** Compute the `-e <abs path>` argv tokens to add to a pi spawn.
 *  Always includes cwd-guard; includes sandbox-fs iff any
 *  sandbox_* verb appears in `tools`. Skips sandbox-fs (returns
 *  cwd-guard only) when no sandbox verbs are requested. */
export function piRailsExtensionArgs(
  sandboxAbs: string,
  toolsCsv: string,
): string[] {
  const components = path.join(sandboxAbs, ".pi", "components");
  const cwdGuardAbs = path.join(components, CWD_GUARD_BASENAME);
  const args = ["-e", cwdGuardAbs];
  const parsed = parseToolsCsv(toolsCsv);
  if (parsed.sandboxVerbs.length > 0) {
    const sandboxFsAbs = path.join(components, SANDBOX_FS_BASENAME);
    args.push("-e", sandboxFsAbs);
  }
  return args;
}

/** Compute the env vars cwd-guard / sandbox-fs need in the child.
 *  Returns an object the caller can splice into a `process.env`
 *  override or print as `K=V` pairs. PI_SANDBOX_VERBS is included
 *  iff at least one sandbox_* verb appears in tools (otherwise
 *  sandbox-fs isn't loaded and the env var is unused). */
export function piRailsEnv(
  sandboxAbs: string,
  toolsCsv: string,
): Record<string, string> {
  const env: Record<string, string> = { PI_SANDBOX_ROOT: sandboxAbs };
  const parsed = parseToolsCsv(toolsCsv);
  if (parsed.sandboxVerbs.length > 0) {
    env.PI_SANDBOX_VERBS = parsed.sandboxVerbs.join(",");
  }
  return env;
}

// ----- CLI surface -----------------------------------------------------

function fail(msg: string, code = 2): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function printArgv(args: string[]): void {
  // One token per line so bash callers can `mapfile -t ARR < <(...)`
  // without worrying about embedded spaces or quoting.
  for (const a of args) process.stdout.write(`${a}\n`);
}

function printEnv(env: Record<string, string>): void {
  // One K=V per line; the caller exports via `while read line; do
  // export "$line"; done` or splices into `env K=V K=V …`.
  for (const [k, v] of Object.entries(env)) {
    process.stdout.write(`${k}=${v}\n`);
  }
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "check": {
      const [tools] = rest;
      if (tools === undefined) {
        fail("usage: pi-rails check <tools-csv>");
      }
      try {
        assertRailsCompatibleTools(tools);
      } catch (e) {
        fail((e as Error).message, 3);
      }
      return;
    }
    case "argv": {
      const [sandbox, tools] = rest;
      if (!sandbox || tools === undefined) {
        fail("usage: pi-rails argv <sandbox-abs> <tools-csv>");
      }
      printArgv(piRailsExtensionArgs(sandbox, tools));
      return;
    }
    case "env": {
      const [sandbox, tools] = rest;
      if (!sandbox || tools === undefined) {
        fail("usage: pi-rails env <sandbox-abs> <tools-csv>");
      }
      printEnv(piRailsEnv(sandbox, tools));
      return;
    }
    default:
      fail(
        `unknown subcommand: ${cmd ?? "(none)"}. ` +
          `Valid: check | argv | env.`,
      );
  }
}

// Run as CLI when invoked directly (tsx scripts/lib/pi-rails.ts ...).
// Importing the module from a test file leaves `main` unused.
const isDirectInvocation = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const url = new URL(`file://${path.resolve(entry)}`).href;
    return url === import.meta.url;
  } catch {
    return false;
  }
})();
if (isDirectInvocation) {
  main(process.argv.slice(2));
}
