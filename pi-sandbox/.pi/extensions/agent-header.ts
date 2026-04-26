// agent-header — replaces pi's default startup header with a two-line
// banner: the agent name (bold accent) and the recipe description
// (dim). Reads AGENT_NAME and AGENT_DESCRIPTION from the environment;
// the runner sets both based on the recipe filename and the recipe's
// `description:` field. If neither is set, the header stays empty
// (no-startup-help's empty render keeps applying).
//
// Pi wraps the header component in two `Spacer(1)` lines that aren't
// removable via the public API, so the banner sits with one blank line
// above and below.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const name = process.env.AGENT_NAME?.trim();
    const description = process.env.AGENT_DESCRIPTION?.trim();
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
