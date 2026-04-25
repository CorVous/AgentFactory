// cwd-guard.ts — the cwd-policy component. Owns three things:
//
//   1. The `validate(p, root)` helper (lex + realpath check against
//      $PI_SANDBOX_ROOT). Exported so sandbox-fs and any other
//      curated component with a privileged-imports exception can
//      route their fs sites through the same canonical check.
//   2. The `PI_SANDBOX_ROOT` env contract: the parentSide sets it
//      from the spawn cwd; the child default-export asserts it's
//      present (fail-fast on misconfig).
//   3. Runtime path-arg auditing. The child default-export attaches
//      `pi.on("tool_call")` and walks args for absolute-path strings,
//      running validate() on each. Catches out-of-cwd path args
//      passed to ANY registered tool, including future role
//      components that take a path arg without remembering to call
//      validate() themselves. Defense-in-depth — sandbox-fs's
//      per-tool-body validate() is the primary enforcement; this
//      auditor backstops it.
//
// cwd-guard registers ZERO tools. The actual sandbox_* tool surface
// (sandbox_read/ls/grep/glob/write/edit) lives in sandbox-fs.ts.
// The split exists so cwd-guard can be auto-injected into every
// sub-pi spawn (universal policy) while sandbox-fs is conditionally
// injected only when a sandbox verb appears in --tools.
//
// Loaded on every sub-pi spawn via the POLICIES registry
// (`pi-sandbox/.pi/lib/policies.ts`). Hand-rolled spawns must still
// load this file via `-e CWD_GUARD_PATH`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  CwdGuardResult,
  CwdGuardState,
  ParentSide,
} from "./_parent-side.ts";

export type SandboxVerb =
  | "sandbox_read"
  | "sandbox_ls"
  | "sandbox_grep"
  | "sandbox_glob"
  | "sandbox_write"
  | "sandbox_edit";

export const ALL_VERBS: ReadonlySet<SandboxVerb> = new Set<SandboxVerb>([
  "sandbox_read",
  "sandbox_ls",
  "sandbox_grep",
  "sandbox_glob",
  "sandbox_write",
  "sandbox_edit",
]);

export const CWD_GUARD_PATH = fileURLToPath(import.meta.url);

/** Validate that `p` (absolute or relative to process.cwd()) stays
 *  inside `root`. Returns the absolute resolved path. Throws on
 *  escape — both lex (`..` traversal, absolute path overrides) and
 *  realpath (symlinked subdirs that resolve outside root). Used by:
 *    - sandbox-fs.ts: per-tool-body check, before any fs.*Sync call.
 *    - cwd-guard's own auditor: tool_call event handler walking args.
 *    - emit-agent-spec.ts, stage-write.ts: privileged role
 *      components, before their direct fs call.
 *
 *  `process.cwd()` is the resolution base for relative paths. In every
 *  call site this matches the sandbox root (the child pi runs with
 *  cwd = sandbox root; the parent's `delegate()` also runs from the
 *  sandbox root), so passing `root === process.cwd()` is the norm. */
export function validate(p: string, root: string): string {
  const ROOT_ABS = path.resolve(root);
  let ROOT_REAL = ROOT_ABS;
  try {
    ROOT_REAL = fs.realpathSync(ROOT_ABS);
  } catch {
    /* realpath fails if root doesn't exist; fall back to lexical. */
  }

  const abs = path.resolve(process.cwd(), p);
  if (abs !== ROOT_ABS && !abs.startsWith(ROOT_ABS + path.sep)) {
    throw new Error(`path escapes sandbox root ${ROOT_ABS}: ${p} -> ${abs}`);
  }

  // Realpath the deepest existing ancestor — `fs.realpathSync` on a
  // path that doesn't yet exist throws, so walk up until we hit one
  // that does, then append the trailing pieces lexically. This catches
  // operations on a symlinked subdir that resolves outside the root.
  let existing = abs;
  const trailing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    trailing.unshift(path.basename(existing));
    existing = parent;
  }
  let realAbs = abs;
  try {
    realAbs = path.join(fs.realpathSync(existing), ...trailing);
  } catch {
    /* realpath failure on the ancestor is unusual; the lex check above passed. */
  }
  if (realAbs !== ROOT_REAL && !realAbs.startsWith(ROOT_REAL + path.sep)) {
    throw new Error(
      `path escapes sandbox root via symlink: ${p} -> ${realAbs} (root ${ROOT_REAL})`,
    );
  }
  return abs;
}

// Allowed prefixes for tool names this auditor may see. Tool names
// outside this set are blocked — defense-in-depth against a future
// component registering a tool whose name shadows a built-in or
// otherwise slips past --tools filtering.
const ALLOWED_TOOL_NAME_RE = /^(sandbox_|stage_|emit_|run_|review$)/;

function walkStringArgs(v: unknown, fn: (s: string) => void): void {
  if (typeof v === "string") {
    fn(v);
  } else if (Array.isArray(v)) {
    for (const x of v) walkStringArgs(x, fn);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) {
      walkStringArgs(x, fn);
    }
  }
}

export default function (pi: ExtensionAPI) {
  const ROOT = process.env.PI_SANDBOX_ROOT;
  if (!ROOT) {
    throw new Error("cwd-guard.ts: PI_SANDBOX_ROOT must be set");
  }

  // tool_call auditor: blocks any tool call whose args contain an
  // absolute-path string outside the sandbox root, or whose tool
  // name doesn't match the allowed-prefix set. Uses pi's
  // ToolCallEventResult contract (return `{block: true, reason}`).
  pi.on("tool_call", (event) => {
    const name = event.toolName;
    if (!ALLOWED_TOOL_NAME_RE.test(name)) {
      return {
        block: true,
        reason: `cwd-guard auditor: unexpected tool name "${name}"`,
      };
    }
    try {
      walkStringArgs(event.input, (s) => {
        if (s.startsWith("/")) validate(s, ROOT);
      });
    } catch (e) {
      return {
        block: true,
        reason: `cwd-guard auditor: ${(e as Error).message}`,
      };
    }
    return {};
  });
}

// Parent-side surface. Singleton — every sub-pi spawn loads cwd-guard
// the same way (no per-spawn config), so there's no factory. The
// auto-injection layer (pi-sandbox/.pi/lib/auto-inject.ts) reads
// this from the POLICIES registry and prepends it to every spawn's
// component list.
export const cwdGuardSide: ParentSide<CwdGuardState, CwdGuardResult> = {
  name: "cwd-guard",
  tools: [],
  spawnArgs: ["-e", CWD_GUARD_PATH],
  env: ({ cwd }) => ({ PI_SANDBOX_ROOT: cwd }),
  initialState: () => ({}),
  harvest: () => {},
  finalize: () => ({}),
};
