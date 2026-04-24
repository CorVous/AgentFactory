#!/usr/bin/env -S npx tsx
/**
 * dump-spec.ts — read tasks/<task-dir>/test.yaml and print shell-evalable
 * assignments plus the prompt body to stdout.
 *
 * Usage: dump-spec.ts <task-dir> <prompt-out-file>
 *
 * Stdout format (shell-eval with `eval "$(...)"`):
 *   TEST_SKILL='pi-agent-assembler'
 *   TEST_EXPECT_KIND='assembly'
 *   TEST_PATTERN='drafter-with-approval'
 *   TEST_PROBE_ARGS=' create a file hello-probe.md with the text hi'
 *
 * The raw prompt is written to the file path in argv[2] so bash doesn't
 * have to escape newlines/quotes.
 */

import fs from "node:fs";
import { loadTestSpec } from "./lib/test-spec.ts";

function shellEscape(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

function main(): void {
  const taskDir = process.argv[2];
  const promptOut = process.argv[3];
  if (!taskDir || !promptOut) {
    console.error("Usage: dump-spec.ts <task-dir> <prompt-out-file>");
    process.exit(2);
  }
  const spec = loadTestSpec(taskDir);
  const kind = spec.expectation.kind;
  const pattern = kind === "assembly" ? spec.expectation.pattern : "";
  const probeArgs = spec.probe?.args ?? "";
  fs.writeFileSync(promptOut, spec.prompt);
  process.stdout.write(
    [
      `TEST_SKILL=${shellEscape(spec.skill)}`,
      `TEST_EXPECT_KIND=${shellEscape(kind)}`,
      `TEST_PATTERN=${shellEscape(pattern)}`,
      `TEST_PROBE_ARGS=${shellEscape(probeArgs)}`,
    ].join("\n") + "\n",
  );
}

main();
