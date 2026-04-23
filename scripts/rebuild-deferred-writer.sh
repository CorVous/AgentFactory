#!/usr/bin/env bash
# rebuild-deferred-writer.sh
#
# Drive the pi-agent-builder skill on each $AGENT_BUILDER_TARGETS model,
# wiping the extensions dir before each pass so there is no prior work for
# the model to copy. Snapshots what pi produced and runs the grader.
#
# Usage:
#   scripts/rebuild-deferred-writer.sh              # round with a fresh timestamp
#   scripts/rebuild-deferred-writer.sh -r <label>   # override round label
#
# Outputs live under pi-sandbox/.pi/scratch/rounds/<label>/<model-slug>/.
# Extensions are NOT automatically restored; use scripts/restore-extensions.sh.

set -euo pipefail

ROUND_LABEL=""
while getopts "r:" opt; do
  case "$opt" in
    r) ROUND_LABEL="$OPTARG" ;;
    *) echo "Usage: $0 [-r round-label]" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

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

# Single-source-of-truth backup — created once and reused across rounds.
BACKUP_DIR="$BACKUP_ROOT/pristine"
if [[ ! -d "$BACKUP_DIR" ]]; then
  echo ">>> Creating pristine backup at $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  cp -a "$EXT_DIR" "$BACKUP_DIR/extensions"
  cp -a "$CHILD_DIR" "$BACKUP_DIR/child-tools"
else
  echo ">>> Reusing existing pristine backup at $BACKUP_DIR"
fi

# The minimal prompt — user-specified, wrapped per AGENTS.md pattern.
USER_PROMPT='Write me an agent that writes to a file in buffer that waits for the user to approve before the writes go through'
WRAPPED_PROMPT="Use the pi-agent-builder skill to: ${USER_PROMPT}."

GRADER="$REPO/scripts/grade-deferred-writer.sh"
if [[ ! -x "$GRADER" ]]; then
  echo "Grader $GRADER is not executable; run 'chmod +x' on it first." >&2
  exit 1
fi

IFS=',' read -ra MODELS <<< "$AGENT_BUILDER_TARGETS"

SUMMARY="$ROUND_DIR/summary.md"
printf "# Round %s\n\n" "$ROUND_LABEL" > "$SUMMARY"
printf "Prompt: \`%s\`\n\n" "$WRAPPED_PROMPT" >> "$SUMMARY"
printf "| Model | P0 passed | P1 passed | Load | Behavioral | Notes |\n" >> "$SUMMARY"
printf "|---|---|---|---|---|---|\n" >> "$SUMMARY"

for MODEL in "${MODELS[@]}"; do
  MODEL_SLUG="${MODEL//\//_}"
  LOG="$ROUND_DIR/$MODEL_SLUG"
  mkdir -p "$LOG" "$LOG/artifacts/extensions" "$LOG/artifacts/child-tools"

  echo
  echo "================================================================"
  echo ">>> Round=$ROUND_LABEL model=$MODEL"
  echo "    log=$LOG"
  echo "================================================================"

  # Fresh slate
  rm -rf "$EXT_DIR"/* "$CHILD_DIR"/* 2>/dev/null || true

  # Invoke pi. Let pi's own tools produce files; we rely on pi's write tool
  # to actually place them under pi-sandbox/.pi/.
  #
  # Notes:
  # - cd into sandbox to match npm run pi behavior.
  # - --no-context-files suppresses AGENTS.md/CLAUDE.md (human docs).
  # - --no-session: ephemeral.
  # - Do NOT pass --no-tools; pi needs write/bash/edit/ls to produce files.
  # - Do NOT pass --no-extensions; there are none to auto-discover anyway
  #   (we just wiped the dir) and the skill is passed explicitly.
  set +e
  timeout 600s env PI_SKIP_UPDATE_CHECK=1 \
    node_modules/.bin/pi \
      --no-context-files \
      --provider openrouter \
      --model "$MODEL" \
      --skill pi-sandbox/skills/pi-agent-builder \
      --mode json \
      --no-session \
      -p "$WRAPPED_PROMPT" \
      > "$LOG/events.ndjson" 2> "$LOG/stderr.log"
  PI_EXIT=$?
  set -e
  echo "pi exit code: $PI_EXIT" > "$LOG/pi-exit.txt"

  # Snapshot whatever pi produced.
  if [[ -d "$EXT_DIR" ]]; then
    cp -a "$EXT_DIR/." "$LOG/artifacts/extensions/" 2>/dev/null || true
  fi
  if [[ -d "$CHILD_DIR" ]]; then
    cp -a "$CHILD_DIR/." "$LOG/artifacts/child-tools/" 2>/dev/null || true
  fi

  # Also capture anything pi wrote elsewhere under .pi/ (some models may
  # invent their own layout). Limit to files that weren't in the backup.
  (
    cd "$SANDBOX"
    find .pi -type f \
      -not -path ".pi/scratch/*" \
      -not -path ".pi/sessions/*" \
      -not -path ".pi/extensions/*" \
      -not -path ".pi/child-tools/*" \
      -printf "%p\n" 2>/dev/null
  ) > "$LOG/extra-files.txt" || true

  # Grade it.
  set +e
  "$GRADER" "$LOG" "$MODEL" > "$LOG/grade.md" 2>&1
  GRADE_EXIT=$?
  set -e
  echo "grader exit: $GRADE_EXIT" >> "$LOG/grade.md"

  # Append the grade JSON row to summary.
  if [[ -f "$LOG/grade.json" ]]; then
    P0=$(jq -r '.p0_passed // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
    P1=$(jq -r '.p1_passed // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
    LD=$(jq -r '.load // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
    BH=$(jq -r '.behavioral // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
    NOTES=$(jq -r '.headline // "?"' "$LOG/grade.json" 2>/dev/null || echo "?")
  else
    P0="?" P1="?" LD="?" BH="?" NOTES="grade.json missing"
  fi
  printf "| \`%s\` | %s | %s | %s | %s | %s |\n" \
    "$MODEL" "$P0" "$P1" "$LD" "$BH" "$NOTES" >> "$SUMMARY"
done

echo
echo ">>> Summary written to $SUMMARY"
echo ">>> Extensions remain wiped. Run scripts/restore-extensions.sh to recover."
