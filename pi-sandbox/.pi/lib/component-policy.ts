// component-policy.ts — parent-side defenses against bad/malicious
// component files. Two checks run at spawn assembly, both inside
// `checkComponentPolicy()`:
//
//   (A) Path allowlist. Only files whose basename is in the
//       hardcoded ROLE_COMPONENTS set (or owned by a POLICIES /
//       TOOL_PROVIDERS registry entry) may be loaded via `-e`.
//       Adding a new component requires editing ROLE_COMPONENTS.
//
//   (B) Static import scan. Each allowlisted file's source is
//       parsed (regex-based, not full-AST) and rejected if it
//       imports any of FORBIDDEN_IMPORTS — node:fs, node:child_process,
//       node:net, node:dgram, node:dns, node:http(s)?,
//       node:worker_threads, node:vm, node:tls, node:cluster, or
//       their non-`node:`-prefixed aliases. Privileged components
//       (cwd-guard.ts, sandbox-fs.ts, stage-write.ts,
//       emit-agent-spec.ts) get a per-file allow-list in
//       PRIVILEGED_IMPORTS — they may import only the modules they
//       legitimately need.
//
// Failure mode: throw at spawn assembly with a clear message. No
// child process spawns until the policy passes.
//
// What this DOESN'T close: a privileged component using
// `process.binding('fs')`, `process.dlopen`, or string-concatenated
// `require` to evade the import scan. Closing those needs Node
// `--experimental-permission` or an OS sandbox; both are deferred.
// The defenses here are calibrated for accidental fs leaks and
// LLM-generated mistakes in a curated repo, not a determined
// attacker.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ParentSide } from "../components/_parent-side.ts";
import { POLICIES } from "./policies.ts";
import { TOOL_PROVIDERS } from "./tool-providers.ts";

const COMPONENTS_DIR = path.resolve(
  fileURLToPath(new URL("../components/", import.meta.url)),
);

/** Hardcoded role components NOT owned by POLICIES/TOOL_PROVIDERS but
 *  legitimately loaded via `-e` from delegate() callers, the YAML
 *  runner, and hand-rolled spawns. Update this set when adding a new
 *  role component (e.g. a new emit-* stub or review-* helper). */
const ROLE_COMPONENTS: ReadonlySet<string> = new Set([
  "stage-write.ts",
  "emit-summary.ts",
  "review.ts",
  "run-deferred-writer.ts",
  "emit-agent-spec.ts",
  "dispatch-agent.ts",
]);

/** Components allowed to import potentially-dangerous Node modules.
 *  The set is per-file so each privileged file is allowlisted for
 *  exactly the modules it legitimately needs — adding a new fs site
 *  to a non-privileged component still fails the scan. */
const PRIVILEGED_IMPORTS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  // cwd-guard.ts uses node:fs for realpathSync inside validate().
  ["cwd-guard.ts", new Set(["node:fs", "node:path", "node:url"])],
  // sandbox-fs.ts uses node:fs in every tool body, after validate().
  ["sandbox-fs.ts", new Set(["node:fs", "node:path", "node:url"])],
  // stage-write.ts uses node:fs for fs.existsSync(destAbs) in its
  // parent-side finalize (the child execute() is a pure stub).
  // It calls validate() before existsSync — see Step 2.6.
  ["stage-write.ts", new Set(["node:fs", "node:path", "node:url"])],
  // emit-agent-spec.ts uses node:fs for fs.mkdirSync +
  // fs.writeFileSync to land the YAML spec. It calls validate()
  // before the mkdir+write — see Step 2.6.
  ["emit-agent-spec.ts", new Set(["node:fs", "node:path", "node:url"])],
  // dispatch-agent.ts uses node:fs in its parent-side finalize to
  // resolve `<sandboxRoot>/.pi/agents/<name>.yml` (existsSync +
  // readFileSync) and to enumerate available agents in the "no such
  // agent" error path (existsSync + readdirSync). The LLM-supplied
  // `name` is path-validated through cwd-guard's validate() before
  // any fs op, matching the stage-write / emit-agent-spec pattern.
  ["dispatch-agent.ts", new Set(["node:fs", "node:path", "node:url"])],
]);

/** Modules a non-privileged component must not import. Aliases of
 *  the same module (with and without `node:` prefix) are listed
 *  separately because the regex scan matches the literal source. */
const FORBIDDEN_IMPORTS: ReadonlySet<string> = new Set([
  "node:fs", "fs",
  "node:fs/promises", "fs/promises",
  "node:child_process", "child_process",
  "node:net", "net",
  "node:dgram", "dgram",
  "node:dns", "dns",
  "node:dns/promises", "dns/promises",
  "node:http", "http",
  "node:https", "https",
  "node:worker_threads", "worker_threads",
  "node:vm", "vm",
  "node:tls", "tls",
  "node:cluster", "cluster",
]);

/** (A) Path allowlist. Throws if `absPath` isn't a known component
 *  file. Compares directory + basename rather than full path so
 *  symlinked checkouts and case-sensitive filesystems both work. */
export function checkComponentPath(absPath: string): void {
  const resolvedPath = path.resolve(absPath);
  const baseDir = path.dirname(resolvedPath);
  if (baseDir !== COMPONENTS_DIR) {
    throw new Error(
      `component-policy: -e path not in pi-sandbox/.pi/components/: ${absPath}`,
    );
  }
  const basename = path.basename(resolvedPath);
  const allowed = allowedBasenames();
  if (!allowed.has(basename)) {
    throw new Error(
      `component-policy: ${basename} not in component allowlist. ` +
        `Add it to ROLE_COMPONENTS in component-policy.ts.`,
    );
  }
}

/** (B) Static import scan. Throws on forbidden imports. Privileged
 *  components get a per-file allow-list. Regex-based scan catches
 *  `import x from "fs"`, `import("fs")`, and `require("fs")` — full
 *  AST parsing would catch obfuscation tricks but those are PR-review
 *  red flags independently. */
export function checkComponentImports(absPath: string): void {
  const basename = path.basename(absPath);
  const privileged = PRIVILEGED_IMPORTS.get(basename) ?? new Set<string>();
  const source = fs.readFileSync(absPath, "utf8");
  const importRe =
    /(?:^|\s)(?:import\s[^"';]*from\s*|import\s*\(\s*|require\s*\()\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(importRe)) {
    const mod = m[1];
    if (FORBIDDEN_IMPORTS.has(mod) && !privileged.has(mod)) {
      throw new Error(
        `component-policy: ${basename} imports forbidden module "${mod}". ` +
          `If this is intentional, add it to PRIVILEGED_IMPORTS in ` +
          `component-policy.ts and call validate() before every fs site.`,
      );
    }
  }
}

/** Run both checks against every `-e <path>` in the assembled
 *  components. Called from auto-inject.ts after the user/auto merge
 *  but before any spawn. */
export function checkComponentPolicy(
  components: ReadonlyArray<ParentSide<any, unknown>>,
): void {
  for (const c of components) {
    for (const p of spawnArgPaths(c.spawnArgs)) {
      checkComponentPath(p);
      checkComponentImports(p);
    }
  }
}

/** The full set of basenames `checkComponentPath` accepts. Computed
 *  lazily from the registries so adding a policy / tool-provider
 *  automatically tightens the allowlist without touching this file. */
function allowedBasenames(): ReadonlySet<string> {
  const out = new Set<string>(ROLE_COMPONENTS);
  for (const p of POLICIES) {
    for (const sp of spawnArgPaths(p.parentSide.spawnArgs)) {
      out.add(path.basename(sp));
    }
  }
  for (const tp of TOOL_PROVIDERS) {
    // Build with the full ownedTokens set just to harvest the
    // child-side path; the actual auto-injected build may use a
    // subset, but the path is fixed per-provider.
    const built = tp.build([...tp.ownedTokens]);
    if (!built) continue;
    for (const sp of spawnArgPaths(built.spawnArgs)) {
      out.add(path.basename(sp));
    }
  }
  return out;
}

function spawnArgPaths(args: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e") out.push(args[i + 1]!);
  }
  return out;
}
