#!/usr/bin/env -S npx tsx
/**
 * validate-prompt.ts — authoring-time lint for composer task prompts.
 *
 * Usage:   validate-prompt.ts [--dir <tasks-dir>]
 *
 * Walks every `composer-*` test.yaml under scripts/task-runner/tasks/,
 * loads its prompt + declared component set, and asserts:
 *
 * 1. The prompt does not contain any literal component name
 *    (FORBIDDEN_LITERALS in signal-map.ts). The agent has to *choose*
 *    components from the ask, not be told.
 * 2. The set inferred from the prompt's signals is a superset of the
 *    declared set, modulo `cwd-guard` (which is implicit for any
 *    write-capable shape — rarely phrased in user prompts).
 *
 * Exits 0 if all tasks pass, 1 otherwise. Run via:
 *   npm run validate-prompts
 */

import fs from "node:fs";
import path from "node:path";
import { FRAMEWORK_ROOT } from "./lib/paths.ts";
import { loadTestSpec, type CompositionExpectation } from "./lib/test-spec.ts";
import {
  findForbiddenLiterals,
  inferComponentsFromPrompt,
} from "./lib/signal-map.ts";
import type { ComponentName } from "./lib/component-spec.ts";

interface TaskReport {
  task: string;
  declared: ComponentName[];
  inferred: ComponentName[];
  missingFromPrompt: ComponentName[];
  forbiddenHits: string[];
  ok: boolean;
}

function main(): void {
  const tasksDir = path.join(FRAMEWORK_ROOT, "task-runner", "tasks");
  if (!fs.existsSync(tasksDir)) {
    console.error(`tasks dir not found: ${tasksDir}`);
    process.exit(2);
  }

  const reports: TaskReport[] = [];
  const entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("composer-")) continue;
    const taskDir = path.join(tasksDir, entry.name);
    const specPath = path.join(taskDir, "test.yaml");
    if (!fs.existsSync(specPath)) continue;

    const spec = loadTestSpec(taskDir);
    if (spec.expectation.kind !== "composition") {
      // GAP-kind composer tasks are out of scope for the prompt
      // validator — a GAP prompt by definition has no declared set
      // to compare against.
      continue;
    }
    reports.push(validateTask(entry.name, spec.prompt, spec.expectation));
  }

  printReport(reports);
  const failed = reports.filter((r) => !r.ok).length;
  if (failed > 0) process.exit(1);
}

function validateTask(
  task: string,
  prompt: string,
  expectation: CompositionExpectation,
): TaskReport {
  const declared = expectation.components as ComponentName[];
  const inferredSet = inferComponentsFromPrompt(prompt);
  const inferred = [...inferredSet];

  // cwd-guard is implicit for any write-capable shape — declared
  // cwd-guard is allowed even if the prompt doesn't trigger the
  // sandbox-phrasing signal, when the rest of the declared set
  // contains a write-capable component.
  const declaredHasWriteCapable =
    declared.includes("stage-write") || declared.includes("run-deferred-writer");
  const missingFromPrompt = declared.filter((c) => {
    if (inferredSet.has(c)) return false;
    if (c === "cwd-guard" && declaredHasWriteCapable) return false;
    return true;
  });

  const forbiddenHits = findForbiddenLiterals(prompt);
  const ok = missingFromPrompt.length === 0 && forbiddenHits.length === 0;
  return { task, declared, inferred, missingFromPrompt, forbiddenHits, ok };
}

function printReport(reports: TaskReport[]): void {
  if (reports.length === 0) {
    console.log("No composer-* tasks found — nothing to validate.");
    return;
  }
  console.log(`Validated ${reports.length} composer task(s):\n`);
  for (const r of reports) {
    const status = r.ok ? "OK" : "FAIL";
    console.log(`[${status}] ${r.task}`);
    console.log(`  declared:  [${r.declared.join(", ")}]`);
    console.log(`  inferred:  [${r.inferred.join(", ")}]`);
    if (r.missingFromPrompt.length > 0) {
      console.log(
        `  missing from prompt: [${r.missingFromPrompt.join(", ")}]`,
      );
    }
    if (r.forbiddenHits.length > 0) {
      console.log(
        `  forbidden literals in prompt: [${r.forbiddenHits.join(", ")}]`,
      );
    }
    console.log("");
  }
  const failed = reports.filter((r) => !r.ok).length;
  console.log(
    `Summary: ${reports.length - failed}/${reports.length} passed${
      failed > 0 ? `, ${failed} failed` : ""
    }`,
  );
}

main();
