#!/usr/bin/env bash
# lib/test-spec-sh.sh — shell-side reader for tasks/<name>/test.yaml.
#
# After sourcing, call `load_test_spec <task-dir>`. Exports:
#   TEST_SKILL        pi-agent-assembler | pi-agent-builder
#   TEST_EXPECT_KIND  assembly | gap
#   TEST_PATTERN      pattern name (assembly kind) or empty (gap)
#   TEST_PROMPT_FILE  path to a tempfile containing the raw prompt
#   TEST_PROBE_ARGS   string appended after /<cmd> in behavioral probe
#
# Delegates YAML parsing + zod validation to grader/dump-spec.ts. A bad
# YAML surfaces as a clear error here rather than a silent mis-grade.

# shellcheck shell=bash

load_test_spec() {
  local task_dir="$1"
  if [[ ! -f "$task_dir/test.yaml" ]]; then
    echo "Test spec not found: $task_dir/test.yaml" >&2
    return 2
  fi

  local here grader
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  grader="$here/../../grader"

  TEST_PROMPT_FILE="$(mktemp "${TMPDIR:-/tmp}/test-prompt.XXXXXX")"
  local assignments
  if ! assignments=$(npx --yes tsx "$grader/dump-spec.ts" "$task_dir" "$TEST_PROMPT_FILE" 2>&1); then
    echo "Failed to load test spec for $task_dir: $assignments" >&2
    rm -f "$TEST_PROMPT_FILE"
    return 2
  fi
  # shellcheck disable=SC2086
  eval "$assignments"
  export TEST_SKILL TEST_EXPECT_KIND TEST_PATTERN TEST_PROBE_ARGS TEST_PROMPT_FILE
}
