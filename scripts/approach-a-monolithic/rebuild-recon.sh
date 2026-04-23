#!/usr/bin/env bash
# rebuild-recon.sh
#
# Track A monolithic-first driver for the recon (read-only directory
# summary) agent task. Forked verbatim from scripts/rebuild-deferred-writer.sh
# with three swaps: USER_PROMPT (recon), wipe patterns (recon-shaped names),
# grader invocation (./scripts/approach-a-monolithic/grade-recon.sh).
#
# Usage:
#   scripts/approach-a-monolithic/rebuild-recon.sh              # round with a fresh timestamp
#   scripts/approach-a-monolithic/rebuild-recon.sh -r <label>   # override round label
#
# Outputs live under pi-sandbox/.pi/scratch/rounds/<label>/<model-slug>/.
# Extensions are NOT automatically restored; use scripts/restore-extensions.sh.

set -euo pipefail

ROUND_LABEL=""
MODEL_OVERRIDE=""
while getopts "r:m:" opt; do
  case "$opt" in
    r) ROUND_LABEL="$OPTARG" ;;
    m) MODEL_OVERRIDE="$OPTARG" ;;
    *) echo "Usage: $0 [-r round-label] [-m model-id]" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
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
# Deliberately short per AGENTS.md: the skill's reading-short-prompts.md row 5
# is supposed to infer --tools read,grep,glob,ls from "reads" + "summary".
USER_PROMPT='Write me an agent that reads a directory and produces a one-page summary of what it contains'
WRAPPED_PROMPT="Use the pi-agent-builder skill to: ${USER_PROMPT}."

GRADER="$REPO/scripts/approach-a-monolithic/grade-recon.sh"
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
printf "# Round %s\n\n" "$ROUND_LABEL" > "$SUMMARY"
printf "Prompt: \`%s\`\n\n" "$WRAPPED_PROMPT" >> "$SUMMARY"
printf "| Model | P0 passed | P1 passed | Load | Behavioral | Notes |\n" >> "$SUMMARY"
printf "|---|---|---|---|---|---|\n" >> "$SUMMARY"

for MODEL in "${MODELS[@]}"; do
  MODEL_SLUG="${MODEL//\//_}"
  LOG="$ROUND_DIR/$MODEL_SLUG"
  mkdir -p "$LOG" "$LOG/artifacts/extensions" "$LOG/artifacts/child-tools" "$LOG/artifacts/stray"

  echo
  echo "================================================================"
  echo ">>> Round=$ROUND_LABEL model=$MODEL"
  echo "    log=$LOG"
  echo "================================================================"

  # Fresh slate across EVERY location a model might try to write to:
  # - pi-sandbox/ (the intended project root) — clean + restore via git
  # - /home/user/AgentFactory/.pi/ (repo root; models sometimes confuse
  #   "project" = repo vs sandbox)
  # - /home/user/.pi/agent/extensions/ + /home/user/.pi/child-tools/
  #   (the global pi dirs) — but only the recon-shaped files we know
  #   models produce, so we don't delete the user's own setup.
  git -C "$REPO" clean -fdq -- pi-sandbox/ || true
  git -C "$REPO" checkout -- pi-sandbox/ 2>/dev/null || true
  rm -rf "$REPO/.pi" 2>/dev/null || true
  find /home/user/.pi/agent/extensions /home/user/.pi/child-tools \
    -maxdepth 2 -type f \
    \( -iname '*recon*' -o -iname '*summary*' -o -iname '*survey*' \
       -o -iname '*reader*' -o -iname '*scout*' \) \
    -delete 2>/dev/null || true
  rm -rf "$EXT_DIR"/* "$CHILD_DIR"/* 2>/dev/null || true

  # Marker used after pi exits to find every new .ts file written anywhere.
  touch "$LOG/.run-start"

  # Invoke pi. Let pi's own tools produce files; we rely on pi's write tool
  # to actually place them under pi-sandbox/.pi/.
  #
  # Notes:
  # - cd into sandbox to match `npm run pi` behavior so pi's auto-discovery
  #   + relative paths resolve inside pi-sandbox/ (not the repo root).
  # - --no-context-files suppresses AGENTS.md/CLAUDE.md (human docs).
  # - --no-session: ephemeral.
  # - Do NOT pass --no-tools; pi needs write/bash/edit/ls to produce files.
  # - Do NOT pass --no-extensions; there are none to auto-discover anyway
  #   (we just wiped the dir) and the skill is passed explicitly.
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

  # Snapshot whatever pi produced at the *intended* paths.
  if [[ -d "$EXT_DIR" ]]; then
    cp -a "$EXT_DIR/." "$LOG/artifacts/extensions/" 2>/dev/null || true
  fi
  if [[ -d "$CHILD_DIR" ]]; then
    cp -a "$CHILD_DIR/." "$LOG/artifacts/child-tools/" 2>/dev/null || true
  fi

  # Also capture EVERY new .ts/.md/.sh file written anywhere plausible.
  # Models often pick the wrong project root; we still want to grade the
  # code they produced and log the layout mistake. `find -newer` picks up
  # everything touched since the .run-start marker above, across:
  # - the repo root (AgentFactory/)
  # - the repo-root .pi/ (if the model treated repo root as project)
  # - the global ~/.pi/ (if the model treated global as target)
  {
    find "$REPO" -newer "$LOG/.run-start" -type f \
      \( -name '*.ts' -o -name '*.md' -o -name '*.sh' \) \
      -not -path "*/.git/*" \
      -not -path "*/node_modules/*" \
      -not -path "*/scratch/*" \
      2>/dev/null
    find /home/user/.pi -newer "$LOG/.run-start" -type f \
      \( -name '*.ts' -o -name '*.md' \) \
      2>/dev/null
  } > "$LOG/new-files.txt"
  # Copy any *.ts new files that weren't already captured at the intended
  # paths into artifacts/stray/, preserving absolute-ish paths so the
  # layout mistake stays legible.
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    # Skip files already in the intended snapshot dirs.
    case "$f" in
      "$EXT_DIR"/*|"$CHILD_DIR"/*) continue ;;
    esac
    [[ "$f" == *.ts ]] || continue
    REL="${f#/}"
    DEST="$LOG/artifacts/stray/$REL"
    mkdir -p "$(dirname "$DEST")"
    cp -a "$f" "$DEST" 2>/dev/null || true
  done < "$LOG/new-files.txt"

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
