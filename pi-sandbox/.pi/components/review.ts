import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import type {
  NDJSONEvent,
  ParentSide,
  ReviewCall,
  ReviewResult,
  ReviewState,
} from "./_parent-side.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "review",
    label: "Review",
    description: "Review a staged file. Approve it for promotion or request a revision with feedback.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Relative path of the staged file being reviewed." }),
      verdict: StringEnum(["approve", "revise"] as const, {
        description: "The verdict for this file.",
      }),
      feedback: Type.Optional(Type.String({ description: "Feedback for the drafter if the verdict is 'revise'." })),
    }),
    async execute(_id, params) {
      return {
        content: [
          {
            type: "text",
            text: "Review recorded.",
          },
        ],
        details: {
          file_path: params.file_path,
          verdict: params.verdict,
          feedback: params.feedback,
        },
      };
    },
  });
}

// Parent-side surface (Phase 2.1). Review is normally part of the RPC
// orchestrator (`rpc-delegator-over-concurrent-drafters`), not a single
// delegate() call — but the harvester shape is the same, so this export
// lets the orchestrator import review.parentSide.harvest directly
// instead of re-implementing the verdict-parsing loop.
const REVIEW_PATH = fileURLToPath(import.meta.url);

export const parentSide: ParentSide<ReviewState, ReviewResult> = {
  tools: ["review"],
  spawnArgs: ["-e", REVIEW_PATH],
  env: () => ({}),
  initialState: () => ({ reviews: [] }),
  harvest: (event: NDJSONEvent, state: ReviewState) => {
    if (event.type !== "tool_execution_start") return;
    if (event.toolName !== "review") return;
    const args = event.args as
      | { file_path?: unknown; verdict?: unknown; feedback?: unknown }
      | undefined;
    if (!args) return;
    if (typeof args.file_path !== "string") return;
    const verdict: ReviewCall["verdict"] =
      args.verdict === "approve" ? "approve" : "revise";
    const feedback =
      typeof args.feedback === "string" ? args.feedback : undefined;
    state.reviews.push({ file_path: args.file_path, verdict, feedback });
  },
  finalize: (state) => {
    const verdictMap = new Map<string, ReviewCall>();
    for (const r of state.reviews) verdictMap.set(r.file_path, r);
    return { verdictMap, reviews: state.reviews };
  },
};
