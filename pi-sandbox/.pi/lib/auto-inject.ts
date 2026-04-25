// auto-inject.ts — augments a caller-supplied component list with the
// universal POLICIES (loaded on every spawn) and the conditional
// TOOL_PROVIDERS (loaded iff their ownedTokens appear in the spawn's
// --tools allowlist), then runs the bad-component policy checks
// (path allowlist + import scan) over the assembled list.
//
// Shared by delegate() and yaml-agent-runner so both paths get the
// same augmentation + the same policy enforcement.

import type { ParentSide } from "../components/_parent-side.ts";
import { POLICIES } from "./policies.ts";
import { TOOL_PROVIDERS } from "./tool-providers.ts";
import { checkComponentPolicy } from "./component-policy.ts";

/** Build the set of names auto-injected by this module — used to
 *  reject caller-supplied components that try to declare them
 *  themselves. */
export function reservedComponentNames(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const p of POLICIES) out.add(p.name);
  for (const tp of TOOL_PROVIDERS) out.add(tp.name);
  return out;
}

/**
 * Prepend the universal policies and any activated tool providers to
 * `userComponents`. Throws if any user component shares a name with
 * an auto-injected entry, and runs `checkComponentPolicy` over the
 * final list before returning.
 *
 * @param userComponents components the caller actually authored
 *        (stage-write, emit-summary, role-specific stubs, etc).
 * @param toolTokens the final --tools allowlist for the spawn.
 *        Tool providers activate iff at least one of their
 *        ownedTokens appears here.
 */
export function augmentComponents(
  userComponents: ReadonlyArray<ParentSide<any, unknown>>,
  toolTokens: ReadonlySet<string>,
): ReadonlyArray<ParentSide<any, unknown>> {
  const reserved = reservedComponentNames();
  for (const c of userComponents) {
    if (reserved.has(c.name)) {
      throw new Error(
        `auto-inject: component "${c.name}" is auto-injected; do not list it.`,
      );
    }
  }
  const auto: ParentSide<any, unknown>[] = [];
  for (const p of POLICIES) auto.push(p.parentSide);
  for (const tp of TOOL_PROVIDERS) {
    const requested: string[] = [];
    for (const tok of tp.ownedTokens) {
      if (toolTokens.has(tok)) requested.push(tok);
    }
    if (requested.length === 0) continue;
    const built = tp.build(requested);
    if (built) auto.push(built);
  }
  const all = [...auto, ...userComponents];
  checkComponentPolicy(all);
  return all;
}
