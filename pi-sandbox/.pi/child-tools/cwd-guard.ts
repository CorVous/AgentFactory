// cwd-guard.ts — pi extension loaded via `pi -e <path>` that provides
// sandbox_write and sandbox_edit tools. Both validate that the target
// path stays inside $PI_SANDBOX_ROOT (set by the agent-maker harness
// to the per-run cwd). Paired with a --tools allowlist that includes
// these names and excludes the built-in write/edit, so the outer
// agent-maker model has no escape path out of the run cwd.
//
// Pattern mirrors pi-sandbox/.pi/child-tools/stage-write.ts.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  const ROOT = process.env.PI_SANDBOX_ROOT;
  if (!ROOT) {
    throw new Error("cwd-guard.ts: PI_SANDBOX_ROOT must be set");
  }
  const ROOT_ABS = path.resolve(ROOT);

  function validate(p: string): string {
    const abs = path.resolve(process.cwd(), p);
    if (abs !== ROOT_ABS && !abs.startsWith(ROOT_ABS + path.sep)) {
      throw new Error(
        `path escapes sandbox root ${ROOT_ABS}: ${p} -> ${abs}`
      );
    }
    return abs;
  }

  pi.registerTool({
    name: "sandbox_write",
    label: "Sandbox Write",
    description:
      "Write content to a file inside the sandbox root (the current " +
      "working directory). Use this IN PLACE OF `write` — the built-in " +
      "`write` tool is disabled in this session. Paths are taken " +
      "relative to cwd. Absolute paths and any `..` that would escape " +
      "the root are rejected.",
    parameters: Type.Object({
      path: Type.String({
        description: "File path relative to the sandbox root.",
      }),
      content: Type.String({ description: "Full file content." }),
    }),
    async execute(_id, params) {
      const abs = validate(params.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, params.content, "utf8");
      const bytes = Buffer.byteLength(params.content, "utf8");
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${bytes} bytes to ${params.path}`,
          },
        ],
        details: { path: params.path, bytes },
      };
    },
  });

  pi.registerTool({
    name: "sandbox_edit",
    label: "Sandbox Edit",
    description:
      "Replace the first occurrence of oldText with newText in a file " +
      "inside the sandbox root. Use this IN PLACE OF `edit` — the " +
      "built-in `edit` tool is disabled in this session. Fails if " +
      "oldText is not found or the path escapes the root.",
    parameters: Type.Object({
      path: Type.String(),
      oldText: Type.String(),
      newText: Type.String(),
    }),
    async execute(_id, params) {
      const abs = validate(params.path);
      const cur = fs.readFileSync(abs, "utf8");
      if (!cur.includes(params.oldText)) {
        throw new Error(`oldText not found in ${params.path}`);
      }
      fs.writeFileSync(
        abs,
        cur.replace(params.oldText, params.newText),
        "utf8"
      );
      return {
        content: [
          { type: "text", text: `Edited ${params.path}` },
        ],
        details: { path: params.path },
      };
    },
  });
}
