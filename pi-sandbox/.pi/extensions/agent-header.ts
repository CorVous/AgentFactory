// agent-header — replaces pi's default startup header with a two-line
// banner: the agent name (bold accent), optionally suffixed dim with the
// model tier (e.g. "deferred-writer · Rabbit Task"), and the recipe
// description on the next line (dim). Reads `--agent-name`,
// `--agent-description`, and `--agent-tier`; the runner sets all three
// from the recipe filename, `description:`, and `model:` (when the
// latter is a tier var name). If none are set, the header stays empty
// (no-startup-help's empty render keeps applying). Each flag can be
// passed on the `npm run agent --` line to override the recipe.
//
// Pi wraps the header component in two `Spacer(1)` lines that aren't
// removable via the public API, so the banner sits with one blank line
// above and below.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";

// RABBIT_TASK_MODEL → "Rabbit Task"; HARE_LEAD_MODEL → "Hare Lead"; etc.
function formatTier(tier: string): string {
  return tier
    .replace(/_MODEL$/, "")
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("agent-name", {
    description: "Agent name shown bold/accent on the first line of the TUI header banner",
    type: "string",
  });
  pi.registerFlag("agent-description", {
    description: "One-line description shown dim under the agent name in the TUI header banner",
    type: "string",
  });
  pi.registerFlag("agent-tier", {
    description: "Model tier var name (e.g. RABBIT_TASK_MODEL) appended dim after the agent name",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const name = (pi.getFlag("agent-name") as string | undefined)?.trim();
    const description = (pi.getFlag("agent-description") as string | undefined)?.trim();
    const tier = (pi.getFlag("agent-tier") as string | undefined)?.trim();
    if (!name && !description) return;

    const tierLabel = tier ? formatTier(tier) : "";

    ctx.ui.setHeader((_tui, theme) => {
      const container = new Container();
      if (name) {
        const head = theme.bold(theme.fg("accent", name));
        const tail = tierLabel ? theme.fg("dim", ` · ${tierLabel}`) : "";
        container.addChild(new Text(head + tail, 1, 0));
      }
      if (description) {
        container.addChild(new Text(theme.fg("dim", description), 1, 0));
      }
      return container;
    });
  });
}
