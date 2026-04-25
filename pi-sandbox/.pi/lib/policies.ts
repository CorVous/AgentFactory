// policies.ts — universal child-side rails. Every entry in POLICIES
// is loaded on every sub-pi spawn that goes through the auto-injector
// (delegate() and the YAML runner). The shape exists so a future
// network-guard, syscall-audit, env-redactor, etc., is a single
// registry entry rather than a delegate.ts edit.
//
// Each policy contributes a parentSide whose:
//   - `tools` is empty (policies don't add LLM-visible tools),
//   - `spawnArgs` carries `-e <path>` to the policy's child-side file,
//   - `env(...)` carries the policy's required env vars (e.g.
//     PI_SANDBOX_ROOT for cwd-guard),
//   - the child-side file attaches event handlers (e.g.
//     `pi.on("tool_call", ...)`) and asserts its env contract.
//
// Adding a new policy is one entry here. delegate() and the YAML
// runner do not reference policies by name — they walk this array.

import type { ParentSide } from "../components/_parent-side.ts";
import { cwdGuardSide } from "../components/cwd-guard.ts";

export interface PolicyComponent {
  /** Stable identifier; must match `parentSide.name`. Used to reject
   *  caller-supplied duplicates. */
  name: string;
  parentSide: ParentSide<any, unknown>;
}

export const POLICIES: ReadonlyArray<PolicyComponent> = [
  { name: "cwd-guard", parentSide: cwdGuardSide },
  // Future entries plug in here, e.g.:
  //   { name: "network-guard", parentSide: networkGuardSide },
  //   { name: "syscall-audit", parentSide: syscallAuditSide },
];

// Init-time sanity: no two policies share a name. Catches a
// copy-paste bug at module load rather than at spawn time.
{
  const seen = new Set<string>();
  for (const p of POLICIES) {
    if (p.name !== p.parentSide.name) {
      throw new Error(
        `policies.ts: entry name "${p.name}" doesn't match parentSide.name "${p.parentSide.name}"`,
      );
    }
    if (seen.has(p.name)) {
      throw new Error(`policies.ts: duplicate policy name "${p.name}"`);
    }
    seen.add(p.name);
  }
}
