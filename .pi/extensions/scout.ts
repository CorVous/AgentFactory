import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "scout",
    label: "Scout",
    description: "Delegate a discovery task to a read-only child pi session.",
    parameters: Type.Object({
      task: Type.String({ description: "The discovery task to perform" }),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      const model = process.env.TASK_MODEL || ctx.model;
      const args = ["-p", params.task, "--no-extensions", "--model", model, "--tools", "read,grep,glob,ls"];

      return new Promise((resolve) => {
        const child = spawn("pi", args, { signal });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (d) => {
          stdout += d.toString();
          onUpdate({ status: `Scout: ${stdout.slice(-60).replace(/\n/g, " ")}` });
        });
        child.stderr.on("data", (d) => { stderr += d.toString(); });

        child.on("close", (code) => {
          if (code !== 0) {
            resolve({
              content: [{ type: "text", text: `Scout failed (exit ${code}):\n${stderr.slice(-2000)}` }],
              isError: true,
            });
            return;
          }
          resolve({
            content: [{ type: "text", text: stdout.trim().slice(0, 20_000) }],
          });
        });

        signal?.addEventListener("abort", () => {
          child.kill();
        });
      });
    },
  });
}
