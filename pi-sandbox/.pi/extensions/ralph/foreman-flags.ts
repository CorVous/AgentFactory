// ralph/foreman-flags — registers the --issue and --mesh-branch CLI flags
// so that pi does not reject them when the Kanban spawns a Foreman.
//
// The Kanban passes these flags via:
//   node scripts/run-agent.mjs ralph/foreman --sandbox <project> -- \
//     --issue <feature-slug>/<NN>-<slug> \
//     --mesh-branch feature/<feature-slug>
//
// Without this extension, pi rejects the flags with "Unknown options".
// No behaviour beyond registerFlag is needed here — the Foreman's prompt
// already documents how to consume them via pi.getFlag().

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("issue", {
    description:
      "Relative path to the issue file under .scratch/, e.g. v1-fixture/issues/01-add-function.md. " +
      "Set by the Kanban when spawning a Foreman.",
    type: "string",
  });

  pi.registerFlag("mesh-branch", {
    description:
      "The parent feature branch, e.g. feature/v1-fixture. " +
      "Set by the Kanban when spawning a Foreman.",
    type: "string",
  });
}
