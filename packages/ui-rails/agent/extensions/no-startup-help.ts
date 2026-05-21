// no-startup-help — suppresses pi's default startup header (logo,
// keybinding cheatsheet, "Press ^O for help", onboarding tips).
//
// Canonical source: this package (pi-sandbox/.pi/extensions/ copy removed in Slice 9).

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
