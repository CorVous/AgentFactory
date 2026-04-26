// agent-header — replaces pi's default startup header with a two-line
// banner: the agent name (bold accent) and the recipe description
// (dim). Reads the `--agent-name` and `--agent-description` flags;
// the runner sets both based on the recipe filename and the recipe's
// `description:` field. If neither is set, the header stays empty
// (no-startup-help's empty render keeps applying). The flags can also
// be passed on the `npm run agent --` line to override the recipe.
//
// Pi wraps the header component in two `Spacer(1)` lines that aren't
// removable via the public API, so the banner sits with one blank line
// above and below.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("agent-name", {
    description: "Agent name shown bold/accent on the first line of the TUI header banner",
    type: "string",
  });
  pi.registerFlag("agent-description", {
    description: "One-line description shown dim under the agent name in the TUI header banner",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const name = (pi.getFlag("agent-name") as string | undefined)?.trim();
    const description = (pi.getFlag("agent-description") as string | undefined)?.trim();
    if (!name && !description) return;

    ctx.ui.setHeader((_tui, theme) => {
      const container = new Container();
      if (name) {
        container.addChild(new Text(theme.bold(theme.fg("accent", name)), 1, 0));
      }
      if (description) {
        container.addChild(new Text(theme.fg("dim", description), 1, 0));
      }
      return container;
    });
  });
}
