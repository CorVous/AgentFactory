#!/usr/bin/env bash
# run-task.sh — drive pi-agent-builder on a given task across every
# model in $AGENT_BUILDER_TARGETS (or a single -m override), snapshot
# what pi produces, and grade each result.
#
# Usage:
#   run-task.sh <task-name>                     # timestamped round
#   run-task.sh <task-name> -r <label>          # explicit round label
#   run-task.sh <task-name> -m <model-id>       # single-model run
#
# Outputs live under pi-sandbox/.pi/scratch/rounds/<label>/<model-slug>/.
# Extensions are wiped between models and left wiped on exit; run
# scripts/restore-extensions.sh to recover.
#
# This is the task-agnostic counterpart to the original
# scripts/rebuild-deferred-writer.sh: the wipe-scan-snapshot-grade loop
# is identical; only the prompt text and the grader are parameterised.

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

USER_PROMPT="$(cat "$TASK_DIR/prompt.txt" | sed -E 's/[[:space:]]+$//')"
WRAPPED_PROMPT="Use the pi-agent-builder skill to: ${USER_PROMPT}."

SANDBOX="$REPO/pi-sandbox"
EXT_DIR="$SANDBOX/.pi/extensions"
CHILD_DIR="$SANDBOX/.pi/child-tools"
SCRATCH="$SANDBOX/.pi/scratch"
BACKUP_ROOT="$SCRATCH/backups"
ROUNDS_ROOT="$SCRATCH/rounds"

if [[ -z "$ROUND_LABEL" ]]; then
  ROUND_LABEL="round-$(date +%Y%m%d-%H%M%S)"
fi
ROUND_DIR="$ROUNDS_ROOT/$ROUND_LABEL"
mkdir -p "$ROUND_DIR" "$BACKUP_ROOT"

# Reuse the shared pristine backup created by rebuild-deferred-writer.sh
# (single source of truth across tracks). Create it here only if missing.
BACKUP_DIR="$BACKUP_ROOT/pristine"
if [[ ! -d "$BACKUP_DIR" ]]; then
  echo ">>> Creating pristine backup at $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  cp -a "$EXT_DIR" "$BACKUP_DIR/extensions"
  cp -a "$CHILD_DIR" "$BACKUP_DIR/child-tools"
else
  echo ">>> Reusing existing pristine backup at $BACKUP_DIR"
fi

GRADER="$HERE/grade-task.sh"
if [[ ! -x "$GRADER" ]]; then
  echo "Grader $GRADER is not executable; run 'chmod +x' on it first." >&2
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
  LOG="$ROUND_DIR/$MODEL_SLUG"
  mkdir -p "$LOG" "$LOG/artifacts/extensions" "$LOG/artifacts/child-tools" "$LOG/artifacts/stray"

  echo
  echo "================================================================"
  echo ">>> Round=$ROUND_LABEL task=$TASK model=$MODEL"
  echo "    log=$LOG"
  echo "================================================================"

  # Fresh slate everywhere a model might try to write — identical logic
  # to rebuild-deferred-writer.sh; see AGENTS.md "Gotchas (harness)"
  # for why all three locations must be scrubbed.
  git -C "$REPO" clean -fdq -- pi-sandbox/ || true
  git -C "$REPO" checkout -- pi-sandbox/ 2>/dev/null || true
  rm -rf "$REPO/.pi" 2>/dev/null || true
  find /home/user/.pi/agent/extensions /home/user/.pi/child-tools \
    -maxdepth 2 -type f \
    \( -iname '*buffered*' -o -iname '*deferred*' -o -iname '*stage*write*' \
       -o -iname '*recon*' -o -iname '*summary*' -o -iname '*survey*' \) \
    -delete 2>/dev/null || true
  rm -rf "$EXT_DIR"/* "$CHILD_DIR"/* 2>/dev/null || true

  touch "$LOG/.run-start"

  set +e
  (
    cd "$SANDBOX"
    timeout 600s env PI_SKIP_UPDATE_CHECK=1 \
      "$REPO/node_modules/.bin/pi" \
        --no-context-files \
        --provider openrouter \
        --model "$MODEL" \
        --skill skills/pi-agent-builder \
        --mode json \
        --no-session \
        -p "$WRAPPED_PROMPT" \
        > "$LOG/events.ndjson" 2> "$LOG/stderr.log"
  )
  PI_EXIT=$?
  set -e
  echo "pi exit code: $PI_EXIT" > "$LOG/pi-exit.txt"

  # Snapshot the intended locations.
  [[ -d "$EXT_DIR"  ]] && cp -a "$EXT_DIR/."  "$LOG/artifacts/extensions/"  2>/dev/null || true
  [[ -d "$CHILD_DIR" ]] && cp -a "$CHILD_DIR/." "$LOG/artifacts/child-tools/" 2>/dev/null || true

  # Capture every new .ts/.md/.sh written anywhere plausible, then
  # funnel stray .ts files into artifacts/stray/ so the grader can
  # promote them via profile_classify_stray.
  {
    find "$REPO" -newer "$LOG/.run-start" -type f \
      \( -name '*.ts' -o -name '*.md' -o -name '*.sh' \) \
      -not -path "*/.git/*" \
      -not -path "*/node_modules/*" \
      -not -path "*/scratch/*" \
      2>/dev/null
    find /home/user/.pi -newer "$LOG/.run-start" -type f \
      \( -name '*.ts' -o -name '*.md' \) \
      2>/dev/null || true
  } > "$LOG/new-files.txt"

  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    case "$f" in
      "$EXT_DIR"/*|"$CHILD_DIR"/*) continue ;;
    esac
    [[ "$f" == *.ts ]] || continue
    REL="${f#/}"
    DEST="$LOG/artifacts/stray/$REL"
    mkdir -p "$(dirname "$DEST")"
    cp -a "$f" "$DEST" 2>/dev/null || true
  done < "$LOG/new-files.txt"

  set +e
  "$GRADER" "$TASK" "$LOG" "$MODEL" > "$LOG/grade.md" 2>&1
  GRADE_EXIT=$?
  set -e
  echo "grader exit: $GRADE_EXIT" >> "$LOG/grade.md"

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
echo ">>> Extensions remain wiped. Run scripts/restore-extensions.sh to recover."
