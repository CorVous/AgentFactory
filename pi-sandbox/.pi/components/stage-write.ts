// stage-write.ts — a "write" tool for child pi processes that DOESN'T touch
// disk. The tool's execute is a stub; the parent harvests path+content from
// the tool_execution_start events emitted in --mode json. This keeps drafts
// purely in-memory (parent's heap), so a process crash leaves no artifacts.
//
// Intended to be loaded into a child only, via `pi -e <abs path>`. The
// parent should pair this with `--tools stage_write,ls,read` so the agent
// has no access to the real write tool.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  NDJSONEvent,
  ParentSide,
  StageWriteResult,
  StageWriteState,
  StagedWritePlan,
} from "./_parent-side.ts";

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

// Parent-side surface (Phase 2.1). Harvests `stage_write` calls from the
// child's NDJSON stdout and validates them at finalize. Promotion +
// confirm-vs-verdict gating lives in the delegate runtime (the correct
// policy depends on whether `review` is in the component set — rails.md §10).
const STAGE_WRITE_PATH = fileURLToPath(import.meta.url);
const MAX_CONTENT_BYTES_PER_FILE = 2_000_000;

const sha256 = (data: string) =>
  createHash("sha256").update(data, "utf8").digest("hex");

export const parentSide: ParentSide<StageWriteState, StageWriteResult> = {
  tools: ["stage_write"],
  spawnArgs: ["-e", STAGE_WRITE_PATH],
  env: () => ({}),
  initialState: () => ({ stagedWrites: [] }),
  harvest: (event: NDJSONEvent, state: StageWriteState) => {
    if (event.type !== "tool_execution_start") return;
    if (event.toolName !== "stage_write") return;
    const args = event.args as { path?: unknown; content?: unknown } | undefined;
    if (!args) return;
    state.stagedWrites.push({ path: args.path, content: args.content });
  },
  finalize: (state, { sandboxRoot }) => {
    const plans: StagedWritePlan[] = [];
    const skips: string[] = [];
    for (const s of state.stagedWrites) {
      if (typeof s.path !== "string" || s.path.length === 0) {
        skips.push(`<invalid path type: ${typeof s.path}>`);
        continue;
      }
      if (typeof s.content !== "string") {
        skips.push(`${s.path}: content is ${typeof s.content}, expected string`);
        continue;
      }
      const relPath = s.path;
      if (
        path.isAbsolute(relPath) ||
        relPath.split("/").includes("..") ||
        relPath.split(path.sep).includes("..")
      ) {
        skips.push(`${relPath}: absolute or contains '..'`);
        continue;
      }
      const destAbs = path.resolve(sandboxRoot, relPath);
      if (destAbs !== sandboxRoot && !destAbs.startsWith(sandboxRoot + path.sep)) {
        skips.push(`${relPath}: escapes sandbox`);
        continue;
      }
      if (fs.existsSync(destAbs)) {
        skips.push(`${relPath}: destination exists at ${destAbs}`);
        continue;
      }
      const byteLength = Buffer.byteLength(s.content, "utf8");
      if (byteLength > MAX_CONTENT_BYTES_PER_FILE) {
        skips.push(`${relPath}: ${byteLength} bytes > ${MAX_CONTENT_BYTES_PER_FILE} limit`);
        continue;
      }
      plans.push({
        relPath,
        destAbs,
        content: s.content,
        sha: sha256(s.content),
        byteLength,
      });
    }
    return { plans, skips };
  },
};
