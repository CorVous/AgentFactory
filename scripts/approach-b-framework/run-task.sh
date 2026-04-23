#!/usr/bin/env bash
# run-task.sh — thin batch loop over agent-maker.sh.
#
# For each model in $AGENT_BUILDER_TARGETS (or a single -m override),
# invoke agent-maker with --grade and collect the resulting grade.json
# rows into a per-round summary.md.
#
# Usage:
#   run-task.sh <task-name>                     # timestamped round
#   run-task.sh <task-name> -r <label>          # explicit round label
#   run-task.sh <task-name> -m <model-id>       # single-model run
#
# Outputs land under pi-sandbox/.pi/scratch/runs/<round>/<model-slug>/
# with a sibling summary.md at pi-sandbox/.pi/scratch/runs/<round>/
# summary.md. Each model runs in its own isolated cwd via agent-maker;
# the shared pi-sandbox/.pi/{extensions,child-tools}/ are not touched,
# so multiple run-task.sh invocations can coexist if given distinct
# -r labels (or run in parallel via xargs -P across agent-maker).

set -euo pipefail

TASK="${1:?task name required (e.g. deferred-writer or recon-agent)}"
shift

ROUND_LABEL=""
MODEL_OVERRIDE=""
while getopts "r:m:" opt; do
  case "$opt" in
    r) ROUND_LABEL="$OPTARG" ;;
    m) MODEL_OVERRIDE="$OPTARG" ;;
    *) echo "Usage: $0 <task> [-r round-label] [-m model-id]" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

TASK_DIR="$HERE/tasks/$TASK"
if [[ ! -f "$TASK_DIR/task.env" || ! -f "$TASK_DIR/prompt.txt" ]]; then
  echo "Task $TASK missing files (need task.env + prompt.txt in $TASK_DIR)" >&2
  exit 2
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY is not set — pi cannot call openrouter models." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source "$REPO/models.env"; set +a
if [[ -z "${AGENT_BUILDER_TARGETS:-}" ]]; then
  echo "AGENT_BUILDER_TARGETS not set after sourcing models.env." >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$TASK_DIR/task.env"
: "${PROFILE:?task.env must set PROFILE}"

USER_PROMPT="$(sed -E 's/[[:space:]]+$//' "$TASK_DIR/prompt.txt")"
WRAPPED_PROMPT="Use the pi-agent-builder skill to: ${USER_PROMPT}."

SANDBOX="$REPO/pi-sandbox"
RUNS_ROOT="$SANDBOX/.pi/scratch/runs"

if [[ -z "$ROUND_LABEL" ]]; then
  ROUND_LABEL="round-$(date +%Y%m%d-%H%M%S)"
fi
ROUND_DIR="$RUNS_ROOT/$ROUND_LABEL"
mkdir -p "$ROUND_DIR"

AGENT_MAKER="$HERE/agent-maker.sh"
if [[ ! -x "$AGENT_MAKER" ]]; then
  echo "agent-maker $AGENT_MAKER is not executable." >&2
  exit 1
fi

if [[ -n "$MODEL_OVERRIDE" ]]; then
  MODELS=("$MODEL_OVERRIDE")
else
  IFS=',' read -ra MODELS <<< "$AGENT_BUILDER_TARGETS"
fi

SUMMARY="$ROUND_DIR/summary.md"
printf "# Round %s — task: %s (profile: %s)\n\n" "$ROUND_LABEL" "$TASK" "$PROFILE" > "$SUMMARY"
printf "Prompt: \`%s\`\n\n" "$WRAPPED_PROMPT" >> "$SUMMARY"
printf "| Model | P0 passed | P1 passed | Load | Behavioral | Headline |\n" >> "$SUMMARY"
printf "|---|---|---|---|---|---|\n" >> "$SUMMARY"

for MODEL in "${MODELS[@]}"; do
  MODEL_SLUG="${MODEL//\//_}"
  LABEL="$ROUND_LABEL/$MODEL_SLUG"
  LOG="$RUNS_ROOT/$LABEL"

  echo
  echo "================================================================"
  echo ">>> Round=$ROUND_LABEL task=$TASK model=$MODEL"
  echo "================================================================"

  set +e
  "$AGENT_MAKER" "$TASK" -m "$MODEL" -l "$LABEL" --grade
  AM_EXIT=$?
  set -e
  echo "agent-maker exit: $AM_EXIT"

  if [[ -f "$LOG/grade.json" ]]; then
    P0=$(jq -r '.p0_passed // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
    P1=$(jq -r '.p1_passed // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
    LD=$(jq -r '.load // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
    BH=$(jq -r '.behavioral // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
    HL=$(jq -r '.headline // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
  else
    P0="?" P1="?" LD="?" BH="?" HL="grade.json missing"
  fi
  printf "| \`%s\` | %s | %s | %s | %s | %s |\n" \
    "$MODEL" "$P0" "$P1" "$LD" "$BH" "$HL" >> "$SUMMARY"
done

echo
echo ">>> Summary written to $SUMMARY"
