import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

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
