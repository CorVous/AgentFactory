#!/usr/bin/env -S npx tsx
/**
 * grader/index.ts — score one model's artifacts against a task's test.yaml.
 *
 * Usage:   grade.ts <task-dir> <log-dir> <model-id>
 *   task-dir    absolute or repo-relative path to a directory containing test.yaml
 *               (e.g. scripts/grader/fixtures/composer-recon)
 *   log-dir     per-model log dir containing artifacts/{extensions,child-tools,stray}
 *   model-id    model string for the grade.json header
 *
 * Outputs: stdout = human markdown; <log-dir>/grade.json = machine row
 *
 * Only `pi-agent-composer` specs are graded by this entry point. Specs
 * targeting other skills are rejected — the assembler/builder paths
 * have been removed; if you need to grade other skill outputs, write
 * a dedicated grader.
 */

import fs from "node:fs";
import path from "node:path";
import { gradeComposerTask } from "./graders/composer.ts";
import { REPO_ROOT } from "./lib/paths.ts";
import { loadTestSpec } from "./lib/test-spec.ts";

function usage(): never {
  console.error(
    "Usage: grade.ts <task-dir> <log-dir> <model-id>\n" +
      "  --help    print this message\n",
  );
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) usage();
  if (argv.length < 3) usage();

  const [taskArg, logDirArg, model] = argv;
  const taskDir = path.isAbsolute(taskArg)
    ? taskArg
    : path.resolve(REPO_ROOT, taskArg);
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
  if (spec.skill !== "pi-agent-composer") {
    console.error(
      `Unsupported skill "${spec.skill}". Only pi-agent-composer specs are graded by this tool.`,
    );
    process.exit(2);
  }

  const task = path.basename(taskDir);
  const { rubric, kind, composition } = gradeComposerTask({
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
    pattern: composition,
  });
}

main();
