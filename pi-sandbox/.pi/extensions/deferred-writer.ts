// deferred-writer.ts — drafter agent whose writes are staged in the
// parent's memory and only hit disk after the user approves.
//
// Phase 2.3 refactor: the 316-line hand-rolled spawn/NDJSON/harvest/
// confirm/promote loop was replaced by a single `delegate()` call with
// the cwd-guard + stage-write components. All rails live in
// `pi-sandbox/.pi/lib/delegate.ts` now.

import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { makeCwdGuard } from "../components/cwd-guard.ts";
import { parentSide as STAGE_WRITE } from "../components/stage-write.ts";
import { delegate } from "../lib/delegate.ts";

// Drafter needs read access to inspect the existing project; writes go
// through stage_write, so no sandbox_write/sandbox_edit verbs.
const CWD_GUARD = makeCwdGuard({ verbs: ["sandbox_read", "sandbox_ls"] });

export default function (pi: ExtensionAPI) {
  pi.registerCommand("deferred-writer", {
    description:
      "Drafter agent stages writes in memory; user reviews and approves before anything hits disk",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /deferred-writer <task description>", "warning");
        return;
      }
      const sandboxRoot = path.resolve(process.cwd());
      const prompt = `You are a DRAFTER. Task: ${args}.

Nothing you do will touch disk until the user approves. To create a file, call the \`stage_write\` tool with a relative \`path\` (inside the project at ${sandboxRoot}) and the full \`content\`. The content stays buffered in the parent's memory; the user will see every draft and only then decide whether to persist them.

Rules:
- Do NOT call any \`write\` tool — only \`stage_write\`.
- Paths must be relative, inside ${sandboxRoot}, no \`..\` segments.
- To inspect the existing project, use \`sandbox_read\` / \`sandbox_ls\` with paths relative to ${sandboxRoot}.
- Stop after you've staged everything the task needs. Reply DONE and stop.`;

      await delegate(ctx, {
        components: [CWD_GUARD, STAGE_WRITE],
        prompt,
      });
    },
  });
}
