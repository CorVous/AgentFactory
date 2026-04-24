#!/usr/bin/env -S npx tsx
/**
 * grader/index.ts — score one model's artifacts against a task's test.yaml.
 *
 * Usage:   grade.ts <task-name> <log-dir> <model-id>
 *   task-name   name of dir under tasks/ (e.g. "deferred-writer")
 *   log-dir     per-model log dir containing artifacts/{extensions,child-tools,stray}
 *   model-id    model string for the grade.json header
 *
 * Outputs: stdout = human markdown; <log-dir>/grade.json = machine row
 *
 * Dispatch: reads tasks/<task>/test.yaml, parses + validates it via
 * lib/test-spec.ts, then routes to the assembler grader for both
 * assembly-kind and gap-kind expectations.
 */

import fs from "node:fs";
import path from "node:path";
import { gradeAssemblerTask } from "./graders/assembler.ts";
import { FRAMEWORK_ROOT, REPO_ROOT } from "./lib/paths.ts";
import { loadTestSpec } from "./lib/test-spec.ts";

function usage(): never {
  console.error(
    "Usage: grade.ts <task-name> <log-dir> <model-id>\n" +
      "  --help    print this message\n",
  );
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) usage();
  if (argv.length < 3) usage();

  const [task, logDirArg, model] = argv;
  const taskDir = path.join(FRAMEWORK_ROOT, "task-runner", "tasks", task);
  if (!fs.existsSync(path.join(taskDir, "test.yaml"))) {
    console.error(`No test.yaml at ${taskDir}/test.yaml`);
    process.exit(2);
  }
  const logDir = path.resolve(logDirArg);
  if (!fs.existsSync(logDir)) {
    console.error(`Log dir not found: ${logDir}`);
    process.exit(2);
  }

  const spec = loadTestSpec(taskDir);

  const { rubric, kind, pattern } = gradeAssemblerTask({
    repoRoot: REPO_ROOT,
    logDir,
    model,
    task,
    spec,
  });

  const md = rubric.emitMarkdown();
  process.stdout.write(md);

  rubric.writeJson(path.join(logDir, "grade.json"), {
    model,
    task,
    skill: spec.skill,
    kind,
    pattern,
  });
}

main();
