import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import type {
  DispatchRequestsResult,
  DispatchRequestsState,
  NDJSONEvent,
  ParentSide,
} from "./_parent-side.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_deferred_writer",
    label: "Run Deferred Writer",
    description:
      "Dispatch a sub-task to a drafter agent. Each call dispatches one independent drafter. " +
      "The 'task' string must be a complete self-contained instruction a drafter can execute without further context.",
    parameters: Type.Object({
      task: Type.String({ description: "Complete, self-contained instruction for the drafter agent." }),
    }),
    async execute(_id, params) {
      return {
        content: [
          {
            type: "text",
            text: "Task queued for deferred-writer pipeline.",
          },
        ],
        details: { task: params.task },
      };
    },
  });
}

// Parent-side surface (Phase 2.1). Like review, run-deferred-writer is
// orchestrator-only (RPC delegator fan-out) — but the harvester shape is
// the same, so exposing it lets the orchestrator import this instead of
// re-implementing the dispatch-list extraction.
const RUN_DEFERRED_WRITER_PATH = fileURLToPath(import.meta.url);

export const parentSide: ParentSide<
  DispatchRequestsState,
  DispatchRequestsResult
> = {
  tools: ["run_deferred_writer"],
  spawnArgs: ["-e", RUN_DEFERRED_WRITER_PATH],
  env: () => ({}),
  initialState: () => ({ tasks: [] }),
  harvest: (event: NDJSONEvent, state: DispatchRequestsState) => {
    if (event.type !== "tool_execution_start") return;
    if (event.toolName !== "run_deferred_writer") return;
    const args = event.args as { task?: unknown } | undefined;
    if (!args || typeof args.task !== "string") return;
    state.tasks.push(args.task);
  },
  finalize: (state) => ({ tasks: state.tasks.slice() }),
};
