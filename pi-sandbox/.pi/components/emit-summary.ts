// emit-summary.ts — a structured-output harvest stub for child pi processes.
// The child calls emit_summary({title, body}) IN PLACE of producing a
// free-form final assistant message; the parent harvests each call from
// the NDJSON `tool_execution_start` event stream (--mode json) and decides
// what to do with the {title, body} pair — display it, persist it to
// .pi/scratch/<name>-summary.md, feed it into a subsequent phase, etc.
//
// Semantics differ from stage-write.ts: stage_* deferred side effects;
// emit_* surfaces structured output, no side effect to commit. Parent
// applies byte caps and validation; the stub itself has no filesystem
// contact.
//
// Intended to be loaded into a child only, via `pi -e <abs path>`. The
// parent should pair this with `--tools emit_summary,<read-only verbs>`
// so the agent has no write/edit channel at all.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import type {
  EmitSummaryResult,
  EmitSummaryState,
  NDJSONEvent,
  ParentSide,
  Summary,
} from "./_parent-side.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "emit_summary",
    label: "Emit Summary",
    description:
      "Emit a named, structured summary for the parent to harvest. " +
      "Use this IN PLACE of producing summaries in free-form assistant text — " +
      "the parent harvests each call from the NDJSON event stream and decides " +
      "what to do with it (display, persist, feed into a next phase). Call " +
      "once per distinct summary; the parent may accept several in one run.",
    parameters: Type.Object({
      title: Type.String({
        description:
          "Short identifying label for this summary (e.g. `directory-survey`, `risk-review`).",
      }),
      body: Type.String({
        description:
          "The full summary text. The parent applies byte caps; don't exceed ~8 KB.",
      }),
    }),
    async execute(_id, params) {
      const bytes = Buffer.byteLength(params.body, "utf8");
      return {
        content: [
          {
            type: "text",
            text: `Emitted summary "${params.title}" (${bytes} bytes). Parent will handle.`,
          },
        ],
        details: { title: params.title, bytes },
      };
    },
  });
}

// Parent-side surface (Phase 2.1). Harvests `emit_summary` calls from the
// child's NDJSON stdout and enforces the per-body byte cap at finalize.
// What to do with the surviving summaries — persist to .pi/scratch/<title>.md
// (recon shape) vs concatenate into a brief (scout shape) — is decided by
// the delegate runtime / calling extension, not here.
const EMIT_SUMMARY_PATH = fileURLToPath(import.meta.url);
const MAX_SUMMARY_BODY_BYTES = 8_192;

export const parentSide: ParentSide<EmitSummaryState, EmitSummaryResult> = {
  name: "emit-summary",
  tools: ["emit_summary"],
  spawnArgs: ["-e", EMIT_SUMMARY_PATH],
  env: () => ({}),
  initialState: () => ({ summaries: [] }),
  harvest: (event: NDJSONEvent, state: EmitSummaryState) => {
    if (event.type !== "tool_execution_start") return;
    if (event.toolName !== "emit_summary") return;
    const args = event.args as { title?: unknown; body?: unknown } | undefined;
    if (!args) return;
    state.summaries.push({ title: args.title, body: args.body });
  },
  finalize: (state) => {
    const summaries: Summary[] = [];
    const skips: string[] = [];
    for (const s of state.summaries) {
      if (typeof s.title !== "string" || s.title.length === 0) {
        skips.push(`<invalid title type: ${typeof s.title}>`);
        continue;
      }
      if (typeof s.body !== "string") {
        skips.push(`${s.title}: body is ${typeof s.body}, expected string`);
        continue;
      }
      const byteLength = Buffer.byteLength(s.body, "utf8");
      if (byteLength > MAX_SUMMARY_BODY_BYTES) {
        skips.push(
          `${s.title}: ${byteLength} bytes > ${MAX_SUMMARY_BODY_BYTES} limit`,
        );
        continue;
      }
      summaries.push({ title: s.title, body: s.body, byteLength });
    }
    return { summaries, skips };
  },
};
