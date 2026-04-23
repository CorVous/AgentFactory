import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

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
