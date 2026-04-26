// no-startup-help — suppresses pi's default startup header (logo,
// keybinding cheatsheet, "Press ^O for help", onboarding tips). Pi
// surrounds the header with spacers, so this leaves a small gap at
// the top of the chat area but removes the help text itself.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setHeader(() => ({
      invalidate() {},
      render() {
        return [];
      },
    }));
  });
}
