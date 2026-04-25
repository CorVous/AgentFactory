// cwd-guard.ts — pi extension loaded via `pi -e <path>` that provides
// sandbox_write and sandbox_edit tools. Both validate that the target
// path stays inside $PI_SANDBOX_ROOT (set by the parent that spawned
// this child). Paired with a --tools allowlist that includes these
// names and excludes the built-in write/edit, so the child model has
// no escape path out of the per-run cwd.
//
// Pattern mirrors pi-sandbox/.pi/components/stage-write.ts.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CwdGuardResult,
  CwdGuardState,
  ParentSide,
} from "./_parent-side.ts";

export default function (pi: ExtensionAPI) {
  const ROOT = process.env.PI_SANDBOX_ROOT;
  if (!ROOT) {
    throw new Error("cwd-guard.ts: PI_SANDBOX_ROOT must be set");
  }
  const ROOT_ABS = path.resolve(ROOT);
  // Also compute the realpath of the root so symlink-based escapes are
  // caught even when a harness mounts directories (e.g. `.pi/components`)
  // into the cwd via `ln -s`. `fs.realpathSync` fails if the root
  // doesn't exist; fall back to the lexical value in that case.
  let ROOT_REAL = ROOT_ABS;
  try { ROOT_REAL = fs.realpathSync(ROOT_ABS); } catch {}

  function validate(p: string): string {
    const abs = path.resolve(process.cwd(), p);
    if (abs !== ROOT_ABS && !abs.startsWith(ROOT_ABS + path.sep)) {
      throw new Error(
        `path escapes sandbox root ${ROOT_ABS}: ${p} -> ${abs}`
      );
    }
    // Realpath the deepest existing ancestor — `fs.realpathSync` on a
    // path that doesn't yet exist throws, so walk up until we hit one
    // that does, then append the trailing pieces lexically. This catches
    // writes into a symlinked subdir (e.g. `<ROOT>/.pi/components ->
    // <REPO>/pi-sandbox/.pi/components`) that would otherwise land
    // outside the run cwd at the filesystem level.
    let existing = abs;
    const trailing: string[] = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      trailing.unshift(path.basename(existing));
      existing = parent;
    }
    let realAbs = abs;
    try {
      realAbs = path.join(fs.realpathSync(existing), ...trailing);
    } catch {
      // realpath failure on the ancestor is unusual; fall through to the
      // lexical value. The startsWith check above already passed.
    }
    if (realAbs !== ROOT_REAL && !realAbs.startsWith(ROOT_REAL + path.sep)) {
      throw new Error(
        `path escapes sandbox root via symlink: ${p} -> ${realAbs} (root ${ROOT_REAL})`
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

// Parent-side surface (Phase 2.1). Consumed by the upcoming delegate()
// runtime. cwd-guard contributes the read+sandbox_*+ls+grep tool set,
// a -e flag loading THIS file into the child, and the PI_SANDBOX_ROOT
// env var pointing at the child's cwd. Nothing to harvest or finalize —
// the child writes directly via sandbox_write/sandbox_edit, which the
// parent does not intercept.
const CWD_GUARD_PATH = fileURLToPath(import.meta.url);

export const parentSide: ParentSide<CwdGuardState, CwdGuardResult> = {
  name: "cwd-guard",
  tools: ["read", "sandbox_write", "sandbox_edit", "ls", "grep"],
  spawnArgs: ["-e", CWD_GUARD_PATH],
  env: ({ cwd }) => ({ PI_SANDBOX_ROOT: cwd }),
  initialState: () => ({}),
  harvest: () => {},
  finalize: () => ({}),
};
