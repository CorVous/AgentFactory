// no-startup-help — suppresses pi's default startup header (logo,
// keybinding cheatsheet, "Press ^O for help", onboarding tips).
//
// NOTE: This file is COPIED from pi-sandbox/.pi/extensions/no-startup-help.ts.
// The pi-sandbox copy is the legacy extension path; the canonical copy is this package.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
