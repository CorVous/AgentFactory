// sandbox-fs.ts — the cwd-confined fs tool surface. Registers
// path-validated sandbox equivalents of every fs-touching built-in
// pi tool (sandbox_read, sandbox_ls, sandbox_grep, sandbox_glob,
// sandbox_write, sandbox_edit). Each tool body calls `validate()`
// from cwd-guard before any `fs.*Sync` call. Paired with a
// parent-side `--tools` allowlist that excludes the built-in
// read/ls/grep/glob/write/edit/bash, the child has no fs channel
// except through these sandbox verbs.
//
// Selective registration: only the verbs listed in $PI_SANDBOX_VERBS
// (comma-separated) are registered. The makeSandboxFs() factory
// builds a ParentSide whose `tools` array matches the requested
// verbs exactly, and sets the env var to gate the child's
// registration. This keeps each role's tool surface minimal — a
// recon child sees only read verbs, a confined-drafter sees
// read+write, a no-fs delegator never loads sandbox-fs at all.
//
// sandbox_bash is intentionally absent. Bash stays in
// FORBIDDEN_TOOLS (delegate.ts) because correctly sandboxing
// arbitrary shell is a separate, much harder problem.
//
// Auto-injected by pi-sandbox/.pi/lib/auto-inject.ts whenever a
// sandbox_* verb appears in the spawn's --tools allowlist.
// Hand-rolled spawns that need fs verbs must load this file
// explicitly via `-e SANDBOX_FS_PATH` and set PI_SANDBOX_VERBS.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  ALL_VERBS,
  validate,
  type SandboxVerb,
} from "./cwd-guard.ts";
import type {
  CwdGuardResult,
  CwdGuardState,
  ParentSide,
} from "./_parent-side.ts";

// Caps to keep responses bounded. Tunable; the values are the
// "agent obviously wants something more focused" thresholds, not
// security limits.
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILES_SCANNED = 2000;
const MAX_GLOB_RESULTS = 500;
const MAX_GLOB_FILES_SCANNED = 5000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

export const SANDBOX_FS_PATH = fileURLToPath(import.meta.url);

export default function (pi: ExtensionAPI) {
  const ROOT = process.env.PI_SANDBOX_ROOT;
  if (!ROOT) {
    throw new Error("sandbox-fs.ts: PI_SANDBOX_ROOT must be set");
  }
  const VERBS_RAW = process.env.PI_SANDBOX_VERBS ?? "";
  const requested = new Set(
    VERBS_RAW.split(",").map((s) => s.trim()).filter(Boolean),
  );
  for (const v of requested) {
    if (!ALL_VERBS.has(v as SandboxVerb)) {
      throw new Error(
        `sandbox-fs.ts: unknown verb in PI_SANDBOX_VERBS: ${v}. ` +
          `Allowed: ${[...ALL_VERBS].join(",")}.`,
      );
    }
  }
  if (requested.size === 0) {
    // Loaded with no verbs requested — nothing to register. This
    // shouldn't happen via auto-injection (the registry only loads
    // sandbox-fs when a verb is in --tools) but stays a no-op for
    // robustness.
    return;
  }

  const ROOT_ABS = path.resolve(ROOT);

  if (requested.has("sandbox_read")) {
    pi.registerTool({
      name: "sandbox_read",
      label: "Sandbox Read",
      description:
        "Read a UTF-8 text file inside the sandbox root. Use IN PLACE OF " +
        "`read` — the built-in `read` tool is disabled in this session. " +
        "Paths are taken relative to cwd. Absolute paths and `..` that " +
        "would escape the root are rejected.",
      parameters: Type.Object({
        path: Type.String({
          description: "File path relative to the sandbox root.",
        }),
      }),
      async execute(_id, params) {
        const abs = validate(params.path, ROOT);
        const text = fs.readFileSync(abs, "utf8");
        const bytes = Buffer.byteLength(text, "utf8");
        return {
          content: [{ type: "text", text }],
          details: { path: params.path, bytes },
        };
      },
    });
  }

  if (requested.has("sandbox_ls")) {
    pi.registerTool({
      name: "sandbox_ls",
      label: "Sandbox Ls",
      description:
        "List the contents of a directory inside the sandbox root. Use " +
        "IN PLACE OF `ls`. Returns each entry's name and kind " +
        "(file/dir/link). Paths are taken relative to cwd. Use `.` for " +
        "the sandbox root itself.",
      parameters: Type.Object({
        path: Type.String({
          description:
            "Directory path relative to the sandbox root. Use `.` for the root.",
        }),
      }),
      async execute(_id, params) {
        const abs = validate(params.path, ROOT);
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        const items = entries.map((e) => ({
          name: e.name,
          kind: e.isDirectory()
            ? "dir"
            : e.isSymbolicLink()
              ? "link"
              : e.isFile()
                ? "file"
                : "other",
        }));
        const text = items
          .map(
            (i) =>
              `${i.kind === "dir" ? "d" : i.kind === "link" ? "l" : "f"} ${i.name}`,
          )
          .join("\n");
        return {
          content: [{ type: "text", text: text || "(empty)" }],
          details: { path: params.path, entries: items },
        };
      },
    });
  }

  if (requested.has("sandbox_grep")) {
    pi.registerTool({
      name: "sandbox_grep",
      label: "Sandbox Grep",
      description:
        "Search file contents under the sandbox root. Use IN PLACE OF " +
        "`grep`. Default mode is literal substring; pass `regex: true` " +
        "for a JS regex. Skips .git/ and node_modules/. Capped at " +
        `${MAX_GREP_MATCHES} matches across ${MAX_GREP_FILES_SCANNED} ` +
        "files.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Substring or regex to find." }),
        path: Type.Optional(
          Type.String({
            description:
              "Directory to search under, relative to sandbox root. Default `.`.",
          }),
        ),
        regex: Type.Optional(
          Type.Boolean({
            description:
              "Treat `pattern` as a JS regex when true. Default false.",
          }),
        ),
      }),
      async execute(_id, params) {
        const startAbs = validate(params.path ?? ".", ROOT);
        const re = params.regex ? new RegExp(params.pattern) : null;
        const matches: Array<{ file: string; line: number; text: string }> = [];
        let filesScanned = 0;
        outer: for (const fileAbs of walkFiles(
          startAbs,
          MAX_GREP_FILES_SCANNED,
        )) {
          filesScanned++;
          let body: string;
          try {
            body = fs.readFileSync(fileAbs, "utf8");
          } catch {
            continue;
          }
          const rel = path.relative(ROOT_ABS, fileAbs);
          const lines = body.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const hit = re ? re.test(lines[i]) : lines[i].includes(params.pattern);
            if (!hit) continue;
            matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 500) });
            if (matches.length >= MAX_GREP_MATCHES) break outer;
          }
        }
        const text =
          matches.length === 0
            ? "(no matches)"
            : matches.map((m) => `${m.file}:${m.line}:${m.text}`).join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            matches,
            filesScanned,
            capped: matches.length >= MAX_GREP_MATCHES,
          },
        };
      },
    });
  }

  if (requested.has("sandbox_glob")) {
    pi.registerTool({
      name: "sandbox_glob",
      label: "Sandbox Glob",
      description:
        "Find files by glob pattern under the sandbox root. Use IN PLACE " +
        "OF `glob`. Supports `*` (within a path segment), `**` (across " +
        "segments), and `?` (single char). Skips .git/ and node_modules/. " +
        `Capped at ${MAX_GLOB_RESULTS} results.`,
      parameters: Type.Object({
        pattern: Type.String({
          description:
            "Glob pattern relative to the search root. Examples: `**/*.ts`, `src/*.json`.",
        }),
        path: Type.Optional(
          Type.String({
            description:
              "Directory to search under, relative to sandbox root. Default `.`.",
          }),
        ),
      }),
      async execute(_id, params) {
        const startAbs = validate(params.path ?? ".", ROOT);
        const re = globToRegExp(params.pattern);
        const matches: string[] = [];
        let filesScanned = 0;
        for (const fileAbs of walkFiles(startAbs, MAX_GLOB_FILES_SCANNED)) {
          filesScanned++;
          const rel = path.relative(startAbs, fileAbs);
          if (!re.test(rel)) continue;
          matches.push(path.relative(ROOT_ABS, fileAbs));
          if (matches.length >= MAX_GLOB_RESULTS) break;
        }
        const text = matches.length === 0 ? "(no matches)" : matches.join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            matches,
            filesScanned,
            capped: matches.length >= MAX_GLOB_RESULTS,
          },
        };
      },
    });
  }

  if (requested.has("sandbox_write")) {
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
        const abs = validate(params.path, ROOT);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, params.content, "utf8");
        const bytes = Buffer.byteLength(params.content, "utf8");
        return {
          content: [
            { type: "text", text: `Wrote ${bytes} bytes to ${params.path}` },
          ],
          details: { path: params.path, bytes },
        };
      },
    });
  }

  if (requested.has("sandbox_edit")) {
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
        const abs = validate(params.path, ROOT);
        const cur = fs.readFileSync(abs, "utf8");
        if (!cur.includes(params.oldText)) {
          throw new Error(`oldText not found in ${params.path}`);
        }
        fs.writeFileSync(
          abs,
          cur.replace(params.oldText, params.newText),
          "utf8",
        );
        return {
          content: [{ type: "text", text: `Edited ${params.path}` }],
          details: { path: params.path },
        };
      },
    });
  }
}

// Recursive file walk. Yields absolute file paths under `startAbs`,
// skipping SKIP_DIRS. Caps the number of files yielded.
function* walkFiles(startAbs: string, cap: number): Iterable<string> {
  const stack: string[] = [startAbs];
  let yielded = 0;
  while (stack.length > 0 && yielded < cap) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        yielded++;
        yield abs;
        if (yielded >= cap) return;
      }
    }
  }
}

// Translate a minimal glob pattern (`*`, `**`, `?`) to an anchored RegExp
// matching paths relative to the search root.
function globToRegExp(pat: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i]!;
    if (c === "*") {
      if (pat[i + 1] === "*") {
        re += ".*";
        i += 2;
        // Eat a following `/` so `**/foo` matches `foo` too.
        if (pat[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^$(){}[]|\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

// Parent-side surface. Built per-spawn from the requested verb subset.
// Throws on empty verbs — sandbox-fs is only auto-injected when at
// least one sandbox verb appears in --tools, so an empty subset is a
// programming error.
export interface MakeSandboxFsOpts {
  verbs: ReadonlyArray<SandboxVerb>;
}

export function makeSandboxFs(
  opts: MakeSandboxFsOpts,
): ParentSide<CwdGuardState, CwdGuardResult> {
  if (opts.verbs.length === 0) {
    throw new Error(
      "makeSandboxFs: verbs must be non-empty. Without sandbox verbs " +
        "the component should not be loaded at all.",
    );
  }
  for (const v of opts.verbs) {
    if (!ALL_VERBS.has(v)) {
      throw new Error(`makeSandboxFs: unknown verb: ${v}`);
    }
  }
  const verbList = [...opts.verbs];
  return {
    name: "sandbox-fs",
    tools: verbList,
    spawnArgs: ["-e", SANDBOX_FS_PATH],
    env: () => ({ PI_SANDBOX_VERBS: verbList.join(",") }),
    initialState: () => ({}),
    harvest: () => {},
    finalize: () => ({}),
  };
}
