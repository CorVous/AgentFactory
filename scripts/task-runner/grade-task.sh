#!/usr/bin/env bash
# grade-task.sh — thin wrapper that delegates to the TypeScript grader.
#
# Usage:   grade-task.sh <task-name> <log-dir> <model-id>
#   task-name   name of dir under tasks/ (e.g. "deferred-writer", "recon-agent")
#   log-dir     per-model log dir containing artifacts/{extensions,child-tools,stray}
#   model-id    model string for the grade.json header
#
# Inputs:  <log-dir>/artifacts/{extensions,child-tools,stray}/*.ts
# Outputs: stdout = human markdown; <log-dir>/grade.json = machine row
#
# The grader itself lives under scripts/grader/ (TypeScript, runs via
# tsx). Keeping a shell wrapper for callers that scripted against the
# old name — delete when no external callers remain.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# Ensure tier vars exist for the behavioral probe when grader is
# invoked standalone (re-run mode).
if [[ -z "${TASK_MODEL:-}" && -f "$REPO/models.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO/models.env"; set +a
fi

exec npx --yes tsx "$REPO/scripts/grader/index.ts" "$@"
