#!/usr/bin/env bash
# grade-task.sh — score one model's artifacts against a task's profile.
#
# Usage:   grade-task.sh <task-name> <log-dir> <model-id>
#   task-name   name of dir under tasks/ (e.g. "deferred-writer", "recon-agent")
#   log-dir     per-model log dir containing artifacts/{extensions,child-tools,stray}
#   model-id    model string for the grade.json header
#
# Inputs:  <log-dir>/artifacts/{extensions,child-tools,stray}/*.ts
# Outputs: stdout = human markdown; <log-dir>/grade.json = machine row
#
# Dispatch: reads tasks/<task>/task.env for PROFILE, sources
# lib/harness.sh + profiles/<PROFILE>.sh + lib/core-rails.sh in that
# order, then calls `profile_grade`.

set -uo pipefail

TASK="${1:?task name required (e.g. deferred-writer)}"
LOG="${2:?log dir required}"
MODEL="${3:?model id required}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SANDBOX="$REPO/pi-sandbox"

TASK_DIR="$HERE/tasks/$TASK"
if [[ ! -f "$TASK_DIR/task.env" ]]; then
  echo "No task definition at $TASK_DIR/task.env" >&2
  exit 2
fi

# Force LOG absolute — probes cd into the sandbox and any relative
# redirect would resolve there, not under the log dir.
LOG="$(cd "$LOG" && pwd)"
ART="$LOG/artifacts"
JSON="$LOG/grade.json"

# Ensure tier vars exist for the behavioral probe when grader is
# invoked standalone (re-run mode).
if [[ -z "${TASK_MODEL:-}" && -f "$REPO/models.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO/models.env"; set +a
fi

# shellcheck disable=SC1091
source "$TASK_DIR/task.env"   # PROFILE, PROBE_ARGS, optional PROBE_EVIDENCE_ANCHOR
: "${PROFILE:?task.env must set PROFILE}"

# shellcheck disable=SC1091
source "$HERE/lib/harness.sh"
# shellcheck disable=SC1091
source "$HERE/profiles/$PROFILE.sh"
# shellcheck disable=SC1091
source "$HERE/lib/core-rails.sh"

discover_artifacts
classify_strays
build_blobs
emit_artifact_header

if [[ ${#EXT_FILES[@]} -eq 0 && ${#CHILD_FILES[@]} -eq 0 ]]; then
  # No artifacts — don't run profile checks; emit a skeletal grade.json
  # so the summary table has a row to include.
  mark_p0 "at least one .ts artifact produced" fail "no output"
  HEADLINE="no artifacts"
  LOAD_STATUS="skip"
  BEH_STATUS="skip"
  emit_summary
  emit_grade_json
  exit 0
fi

profile_grade

HEADLINE=$(headline_for)
emit_summary
emit_grade_json
