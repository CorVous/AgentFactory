// tool-providers.ts — conditional child-side tool surfaces. Each
// entry in TOOL_PROVIDERS owns a set of tool tokens (`ownedTokens`);
// the auto-injector activates the provider for a given spawn iff
// the spawn's --tools allowlist contains at least one of those
// tokens. Splitting tool surfaces from policies (in policies.ts)
// keeps the universal-vs-conditional distinction explicit: policies
// always load, providers load only when their tools are needed.
//
// Adding a new fs-adjacent surface (e.g. a per-verb sandbox split,
// or a sandbox_net for HTTP) is one entry here.

import {
  ALL_VERBS as SANDBOX_VERBS,
  type SandboxVerb,
} from "../components/cwd-guard.ts";
import { makeSandboxFs } from "../components/sandbox-fs.ts";
import type { ParentSide } from "../components/_parent-side.ts";
import { POLICIES } from "./policies.ts";

export interface ToolProvider {
  /** Stable identifier; matches the produced parentSide.name. */
  name: string;
  /** All tokens this provider can register. Used both for routing
   *  (which provider activates for a given --tools CSV) and to
   *  reserve the names so user-listed components can't shadow
   *  them. */
  ownedTokens: ReadonlySet<string>;
  /** Build the parentSide for the requested subset of ownedTokens.
   *  Return undefined if the subset is empty (provider not
   *  activated). */
  build: (
    requested: ReadonlyArray<string>,
  ) => ParentSide<any, unknown> | undefined;
}

export const TOOL_PROVIDERS: ReadonlyArray<ToolProvider> = [
  {
    name: "sandbox-fs",
    ownedTokens: SANDBOX_VERBS,
    build: (requested) =>
      requested.length > 0
        ? makeSandboxFs({ verbs: requested as SandboxVerb[] })
        : undefined,
  },
  // Future entries: a per-verb sandbox split would add several
  // small entries here (sandbox-read, sandbox-write, …) without
  // touching delegate() or the YAML runner.
];

// Init-time sanity:
//   - no two providers' ownedTokens sets intersect (a token must
//     map to exactly one provider),
//   - no provider name collides with a policy name.
{
  const tokenOwner = new Map<string, string>();
  for (const tp of TOOL_PROVIDERS) {
    for (const tok of tp.ownedTokens) {
      const prev = tokenOwner.get(tok);
      if (prev !== undefined && prev !== tp.name) {
        throw new Error(
          `tool-providers.ts: token "${tok}" claimed by both ` +
            `"${prev}" and "${tp.name}"`,
        );
      }
      tokenOwner.set(tok, tp.name);
    }
  }
  const policyNames = new Set(POLICIES.map((p) => p.name));
  for (const tp of TOOL_PROVIDERS) {
    if (policyNames.has(tp.name)) {
      throw new Error(
        `tool-providers.ts: provider name "${tp.name}" collides ` +
          `with a policy of the same name`,
      );
    }
  }
}
