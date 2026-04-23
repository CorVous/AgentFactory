#!/usr/bin/env bash
# agent-maker.sh — one pi agent-making invocation, per-run isolated.
#
# Runs pi in a fresh cwd under pi-sandbox/.pi/scratch/runs/<label>/
# with:
#   - the pi-agent-builder skill loaded (absolute path)
#   - a narrow --tools allowlist (no write/edit/bash)
#   - cwd-guard.ts extension adding sandbox_write/sandbox_edit that
#     reject any path outside cwd
#
# Usage:
#   agent-maker.sh <task>       [-m <model>] [-l <label>] [--grade]
#   agent-maker.sh --interactive [-m <model>] [-l <label>]
#
# Examples:
#   agent-maker.sh recon-agent -m anthropic/claude-haiku-4.5 --grade
#   agent-maker.sh --interactive -m google/gemini-3-flash-preview
#
# Artifacts land under the run cwd:
#   .pi/{extensions,child-tools,scratch}/   — pi auto-discovery dirs
#   artifacts/{extensions,child-tools,stray}/ — grade-task.sh inputs
#   events.ndjson  stderr.log  pi-exit.txt
#   grade.md  grade.json                      — if --grade

set -euo pipefail

INTERACTIVE=0
TASK=""
MODEL_OVERRIDE=""
LABEL=""
DO_GRADE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--interactive)
      INTERACTIVE=1; shift ;;
    -m)
      MODEL_OVERRIDE="$2"; shift 2 ;;
    -l)
      LABEL="$2"; shift 2 ;;
    --grade)
      DO_GRADE=1; shift ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    -*)
      echo "Unknown flag: $1" >&2; exit 2 ;;
    *)
      if [[ -z "$TASK" ]]; then TASK="$1"; else
        echo "Unexpected positional arg: $1" >&2; exit 2
      fi
      shift ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SANDBOX="$REPO/pi-sandbox"
SKILL="$REPO/pi-sandbox/skills/pi-agent-builder"
GUARD="$REPO/pi-sandbox/.pi/child-tools/cwd-guard.ts"
RUNS_ROOT="$SANDBOX/.pi/scratch/runs"

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY not set; pi cannot call openrouter." >&2
  exit 1
fi

# Ensure model tier vars are populated when invoked standalone.
if [[ -z "${TASK_MODEL:-}" && -f "$REPO/models.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO/models.env"; set +a
fi

MODEL="${MODEL_OVERRIDE:-${TASK_MODEL:-}}"
if [[ -z "$MODEL" ]]; then
  echo "No model: pass -m <model> or export TASK_MODEL." >&2
  exit 2
fi

if [[ $INTERACTIVE -eq 0 ]]; then
  if [[ -z "$TASK" ]]; then
    echo "One-shot mode requires <task>. Use --interactive for REPL." >&2
    exit 2
  fi
  TASK_DIR="$HERE/tasks/$TASK"
  if [[ ! -f "$TASK_DIR/task.env" || ! -f "$TASK_DIR/prompt.txt" ]]; then
    echo "Task $TASK missing files at $TASK_DIR." >&2
    exit 2
  fi
  USER_PROMPT="$(sed -E 's/[[:space:]]+$//' "$TASK_DIR/prompt.txt")"
  WRAPPED="Use the pi-agent-builder skill to: ${USER_PROMPT}."
fi

if [[ -z "$LABEL" ]]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  MODEL_SLUG="${MODEL//\//_}"
  if [[ $INTERACTIVE -eq 1 ]]; then
    LABEL="interactive-${MODEL_SLUG}-${TS}-$$"
  else
    LABEL="${TASK}-${MODEL_SLUG}-${TS}-$$"
  fi
fi

CWD="$RUNS_ROOT/$LABEL"
mkdir -p \
  "$CWD/.pi/extensions" \
  "$CWD/.pi/child-tools" \
  "$CWD/.pi/scratch" \
  "$CWD/artifacts/extensions" \
  "$CWD/artifacts/child-tools" \
  "$CWD/artifacts/stray"

# Symlink the shared skills dir so tasks whose PROBE_ARGS reference a
# relative path like "skills/pi-agent-builder" (as fixture for a recon
# probe) resolve correctly when the behavioral probe runs from $CWD.
# The skill is read-only from the run's perspective.
if [[ ! -e "$CWD/skills" ]]; then
  ln -s "$SANDBOX/skills" "$CWD/skills"
fi

echo ">>> agent-maker label=$LABEL model=$MODEL mode=$( [[ $INTERACTIVE -eq 1 ]] && echo interactive || echo one-shot )"
echo "    cwd=$CWD"

touch "$CWD/.run-start"

if [[ $INTERACTIVE -eq 1 ]]; then
  # Interactive TUI: stdin/stdout go to the terminal. No event capture,
  # no snapshot, no grade. User drives the session.
  (
    cd "$CWD"
    exec env \
      PI_SKIP_UPDATE_CHECK=1 \
      PI_SANDBOX_ROOT="$CWD" \
      "$REPO/node_modules/.bin/pi" \
        --no-context-files --no-session \
        --provider openrouter --model "$MODEL" \
        --skill "$SKILL" \
        -e "$GUARD" \
        --tools "read,sandbox_write,sandbox_edit,ls,grep"
  )
  # exec above means we don't reach here on normal flow.
  exit 0
fi

# One-shot mode.
set +e
(
  cd "$CWD"
  timeout 600s env \
    PI_SKIP_UPDATE_CHECK=1 \
    PI_SANDBOX_ROOT="$CWD" \
    "$REPO/node_modules/.bin/pi" \
      --no-context-files --no-session \
      --provider openrouter --model "$MODEL" \
      --skill "$SKILL" \
      -e "$GUARD" \
      --tools "read,sandbox_write,sandbox_edit,ls,grep" \
      --mode json \
      -p "$WRAPPED" \
      > "$CWD/events.ndjson" 2> "$CWD/stderr.log"
)
PI_EXIT=$?
set -e
echo "pi exit code: $PI_EXIT" > "$CWD/pi-exit.txt"
echo "    pi exit=$PI_EXIT events=$(wc -l < "$CWD/events.ndjson" 2>/dev/null | awk '{print $1+0}')"

# Snapshot cwd-local .pi dirs into artifacts/ for grade-task.sh.
[[ -d "$CWD/.pi/extensions"  ]] && cp -a "$CWD/.pi/extensions/."  "$CWD/artifacts/extensions/"  2>/dev/null || true
[[ -d "$CWD/.pi/child-tools" ]] && cp -a "$CWD/.pi/child-tools/." "$CWD/artifacts/child-tools/" 2>/dev/null || true

# Stray hunt — anything new under $SANDBOX that indicates an escape
# OUT of the run cwd into the shared sandbox. Scope excludes the
# entire runs/ tree (so parallel siblings' artifacts don't show up as
# false positives) and the usual git/node_modules noise. With the
# cwd-guard + narrow --tools, we expect zero hits. Presence of strays
# signals either a guard bypass or a skill-induced write via a tool
# we didn't block — diagnostic only.
{
  find "$SANDBOX" -newer "$CWD/.run-start" -type f \
    \( -name '*.ts' -o -name '*.md' -o -name '*.sh' \) \
    -not -path "$RUNS_ROOT/*" \
    -not -path "*/.git/*" \
    -not -path "*/node_modules/*" \
    2>/dev/null || true
} > "$CWD/strays.txt"

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  REL="${f#/}"
  DEST="$CWD/artifacts/stray/$REL"
  mkdir -p "$(dirname "$DEST")"
  cp -a "$f" "$DEST" 2>/dev/null || true
done < "$CWD/strays.txt"

if [[ $DO_GRADE -eq 1 ]]; then
  set +e
  "$HERE/grade-task.sh" "$TASK" "$CWD" "$MODEL" > "$CWD/grade.md" 2>&1
  GRADE_EXIT=$?
  set -e
  echo "grader exit: $GRADE_EXIT" >> "$CWD/grade.md"
  if [[ -f "$CWD/grade.json" ]]; then
    P0=$(jq -r '.p0_passed // "?"' "$CWD/grade.json" 2>/dev/null || echo "?")
    P1=$(jq -r '.p1_passed // "?"' "$CWD/grade.json" 2>/dev/null || echo "?")
    echo "    grade p0=$P0 p1=$P1"
  fi
fi
