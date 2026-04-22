// stage-write.ts — a "write" tool for child pi processes that DOESN'T touch
// disk. The tool's execute is a stub; the parent harvests path+content from
// the tool_execution_start events emitted in --mode json. This keeps drafts
// purely in-memory (parent's heap), so a process crash leaves no artifacts.
//
// Intended to be loaded into a child only, via `pi -e <abs path>`. The
// parent should pair this with `--tools stage_write,ls,read` so the agent
// has no access to the real write tool.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "stage_write",
    label: "Stage Write",
    description:
      "Draft a file. Content is staged in the parent's memory for user review before being persisted. " +
      "Use this in place of `write`. The `path` must be relative to the project root (no absolute paths, " +
      "no `..`). The parent will preview and promote approved drafts; unapproved drafts are discarded.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative destination path inside the project root." }),
      content: Type.String({ description: "Full text content of the file." }),
    }),
    async execute(_id, params) {
      const bytes = Buffer.byteLength(params.content, "utf8");
      return {
        content: [
          {
            type: "text",
            text: `Drafted ${params.path} (${bytes} bytes). Staged for user approval; not yet written to disk.`,
          },
        ],
        details: { path: params.path, bytes },
      };
    },
  });
}
