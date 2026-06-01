// manifest-deps.test.ts — static guard: every runtime value-import in
// agent/**/*.{ts,mjs} must be declared in dependencies|peerDependencies|optionalDependencies.
//
// NOTE: monorepo hoisting masks under-declaration at install time — npm
// satisfies an import from a root-level dep even when the sub-package never
// lists it. This static scan is the real protection against packaging bugs
// where a standalone install would fail.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";

// ── Package roots (relative to this file) ────────────────────────────────────

const ENGINE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const PACKAGES = [
  { label: "engine",           root: ENGINE_ROOT },
  { label: "deferred-rails",   root: join(ENGINE_ROOT, "..", "deferred-rails") },
  { label: "containment-rails",root: join(ENGINE_ROOT, "..", "containment-rails") },
  { label: "ui-rails",         root: join(ENGINE_ROOT, "..", "ui-rails") },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalize an import specifier to its package name. */
function toPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    // @scope/pkg  or  @scope/pkg/subpath
    const parts = specifier.split("/");
    return `${parts[0]}/${parts[1]}`;
  }
  // pkg  or  pkg/subpath
  return specifier.split("/")[0]!;
}

/** True if the specifier refers to a Node.js built-in. */
function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return isBuiltin(specifier);
}

/** Collect all *.ts and *.mjs files under `dir`, excluding *.test.* files. */
function walkAgentFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkAgentFiles(full));
    } else {
      const ext = extname(entry);
      const isSource = ext === ".ts" || ext === ".mjs";
      const isTest = entry.includes(".test.");
      if (isSource && !isTest) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * Extract all non-type, non-relative, non-builtin import specifiers from
 * source text.
 *
 * Rules (matching the planner spec):
 *  - Skip `import type …` / `export type …` whole-statement type imports.
 *  - KEEP mixed `import { x, type Y } from "…"` — has a value binding.
 *  - Skip relative specifiers (starting with "./" or "../").
 *  - Skip Node.js builtins.
 *  - Also collect `_require("pkg")` / `require("pkg")` dynamic requires.
 *
 * Implementation notes:
 *  - We strip line comments and identify import/export statements by finding
 *    lines that START with `import` or `export` (at column 0 or after only
 *    whitespace). We then join the statement lines until the first occurrence
 *    of `from "…"` or `from '…'`, or until we see that it's a bare import.
 *  - Template literals in function bodies cannot start at column 0 with the
 *    keyword `import` or `export`, so this avoids false positives from log
 *    strings.
 */
function extractSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();

  // Strip single-line comments to avoid matching `// import "foo"` patterns.
  // We do NOT strip block comments or template literals — we rely on the
  // structural invariant that real import/export statements start at column 0.
  const strippedLines = source.split("\n").map((l) => {
    // Remove `//` comments (naively — good enough for our purpose)
    const commentIdx = l.indexOf("//");
    return commentIdx >= 0 ? l.slice(0, commentIdx) : l;
  });

  // Identify import/export statement "blocks": a sequence of lines starting
  // from a line that begins (optionally with whitespace) with `import` or
  // `export`, continuing until the `from "…"` or `from '…'` terminator (or
  // a semicolon, whichever comes first if there's no `from`).
  let i = 0;
  while (i < strippedLines.length) {
    const line = strippedLines[i]!;
    const trimmed = line.trimStart();

    if (/^(import|export)\s/.test(trimmed)) {
      // Collect lines until we find `from "…"` or `from '…'` or end of stmt
      const stmtLines: string[] = [line];
      let found = false;

      // Check if `from "…"` is on this line already
      const fromHere = /\bfrom\s+["']([^"']+)["']/.exec(line);
      if (fromHere) {
        found = true;
      } else {
        // Multi-line import: accumulate until `from "…"` appears
        let j = i + 1;
        while (j < strippedLines.length) {
          const next = strippedLines[j]!;
          stmtLines.push(next);
          if (/\bfrom\s+["']([^"']+)["']/.test(next)) {
            found = true;
            break;
          }
          // If we hit a line that isn't a continuation (empty, or starts with
          // a non-import keyword) bail out — avoid runaway matching.
          const nt = next.trim();
          if (nt === "" || /^(const|let|var|function|class|if|for|while|switch|return|throw|try|case|default|\/\/)/.test(nt)) {
            break;
          }
          j++;
        }
        if (found) i = j; // advance outer loop past the multi-line block
      }

      const stmtText = stmtLines.join(" ");

      // Is it a type-only import/export?
      const isTypeOnly = /^(import|export)\s+type\s/.test(trimmed);

      if (!isTypeOnly && found) {
        const m2 = /\bfrom\s+["']([^"']+)["']/.exec(stmtText);
        if (m2) {
          specifiers.add(m2[1]!);
        }
      }

      // Bare side-effect import: `import "specifier"` (no `from`)
      if (!found) {
        const bareMatch = /^import\s+["']([^"']+)["']/.exec(trimmed);
        if (bareMatch) {
          specifiers.add(bareMatch[1]!);
        }
      }
    }

    i++;
  }

  // Dynamic _require("pkg") / require("pkg")
  const requireRe = /\b_?require\s*\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = requireRe.exec(source)) !== null) {
    specifiers.add(m[1]!);
  }

  // Filter out relative, builtins, and normalize
  const result: string[] = [];
  for (const spec of specifiers) {
    if (spec.startsWith("./") || spec.startsWith("../")) continue;
    if (isNodeBuiltin(spec)) continue;
    result.push(spec);
  }
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("manifest-deps guard", () => {
  it.each(PACKAGES)(
    "$label: every runtime import specifier is declared in the manifest",
    ({ label, root }) => {
      // 1. Read package.json and build allowedSet
      const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      const allowedSet = new Set<string>([
        pkgJson.name as string,
        ...Object.keys(pkgJson.dependencies ?? {}),
        ...Object.keys(pkgJson.peerDependencies ?? {}),
        ...Object.keys(pkgJson.optionalDependencies ?? {}),
      ]);

      // 2. Walk agent/**/*.{ts,mjs} excluding *.test.*
      const agentDir = join(root, "agent");
      const files = walkAgentFiles(agentDir);

      // 3+4+5. Collect and normalize specifiers, check each against allowedSet
      const missing: Array<{ pkg: string; specifier: string; file: string }> = [];

      for (const file of files) {
        const source = readFileSync(file, "utf8");
        const specifiers = extractSpecifiers(source);
        for (const spec of specifiers) {
          const pkgName = toPackageName(spec);
          if (!allowedSet.has(pkgName)) {
            missing.push({ pkg: label, specifier: spec, file: file.replace(root, `<${label}>`) });
          }
        }
      }

      // 6. Assert no missing declarations
      expect(
        missing,
        `Package "${label}" has runtime imports not declared in package.json:\n` +
          missing.map((m) => `  ${m.specifier} (${m.file})`).join("\n"),
      ).toEqual([]);
    },
  );

  it('no manifest entry uses the wildcard "*" version across all four packages', () => {
    const wildcards: Array<{ pkg: string; dep: string; version: string }> = [];

    for (const { label, root } of PACKAGES) {
      const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      for (const section of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
        for (const [dep, version] of Object.entries(pkgJson[section] ?? {})) {
          if (version === "*") {
            wildcards.push({ pkg: label, dep, version: version as string });
          }
        }
      }
    }

    expect(
      wildcards,
      'Found wildcard "*" versions in package manifests:\n' +
        wildcards.map((w) => `  ${w.pkg}: ${w.dep}@${w.version}`).join("\n"),
    ).toEqual([]);
  });
});
