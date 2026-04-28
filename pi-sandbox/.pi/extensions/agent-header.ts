// agent-header — replaces pi's default startup header with a two-line
// banner: the agent name (bold accent), optionally suffixed dim with the
// model tier (e.g. "deferred-writer · Task Rabbit"), and the recipe
// description on the next line (dim). Reads identity fields from
// getHabitat(); falls back gracefully when Habitat is unavailable.
//
// Pi wraps the header component in two `Spacer(1)` lines that aren't
// removable via the public API, so the banner sits with one blank line
// above and below.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { prettify } from "./_lib/agent-naming";
import { getHabitat } from "./_lib/habitat";

// TASK_RABBIT_MODEL → "Task Rabbit"; LEAD_HARE_MODEL → "Lead Hare"; etc.
function formatTier(tier: string): string {
  return tier
    .replace(/_MODEL$/, "")
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    let name: string | undefined;
    let description: string | undefined;
    let tier: string | undefined;
    let type: string | undefined;
    try {
      const h = getHabitat();
      name = h.agentName?.trim() || undefined;
      description = h.description?.trim() || undefined;
      tier = h.tier?.trim() || undefined;
      type = h.type?.trim() || undefined;
    } catch {
      // Habitat not available; render nothing.
    }

    if (!name && !description && !type) return;

    const tierLabel = tier ? formatTier(tier) : "";
    const typeLabel = type ? prettify(type) : "";

    ctx.ui.setHeader((_tui, theme) => {
      const container = new Container();
      if (name) {
        // Display form combines the breed (first segment of the
        // <breed>-<shortName> slug) with the prettified recipe
        // filename, giving "Cinnamon Deferred Author" rather than the
        // compact slug-prettify "Cinnamon Author". Falls back to plain
        // prettify(name) when --agent-type was not set or when
        // agentName has no hyphen (e.g. a manually-set peer name).
        const breed = name.includes("-") ? name.split("-")[0] : "";
        const displayName = typeLabel && breed
          ? `${prettify(breed)} ${typeLabel}`
          : prettify(name);
        const head = theme.bold(theme.fg("accent", displayName));
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
