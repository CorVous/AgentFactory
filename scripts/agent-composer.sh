#!/usr/bin/env bash
# agent-composer.sh — drive the pi-agent-composer skill in a tight,
# write-restricted pi spawn whose only output channel is the
# `emit_agent_spec` tool. Output lands at
# pi-sandbox/.pi/agents/<spec.name>.yml and is picked up by the
# auto-discovered yaml-agent-runner extension on the next pi run.
#
# Standalone — does NOT wrap scripts/task-runner/agent-maker.sh.
# agent-maker is the legacy author-the-TS path used by pi-agent-builder
# and pi-agent-assembler; agent-composer is the forward-looking emit-the-
# YAML path. They share patterns but no code.
#
# Usage:
#   agent-composer.sh -p "<prompt>"  [-m <model>]
#   agent-composer.sh -i             [-m <model>]
#
# Examples:
#   agent-composer.sh -p "Drafter that stages writes for approval"
#   agent-composer.sh -i -m google/gemini-3-flash-preview
#
# The npm wrapper (`npm run agent-composer`) sources models.env first so
# $TASK_MODEL is in scope. Direct invocation needs the same.

set -euo pipefail

INTERACTIVE=0
PROMPT=""
MODEL_OVERRIDE=""

usage() { sed -n '2,23p' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--interactive) INTERACTIVE=1; shift ;;
    -p) PROMPT="$2"; shift 2 ;;
    -m) MODEL_OVERRIDE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *) echo "Unexpected positional arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ $INTERACTIVE -eq 0 && -z "$PROMPT" ]]; then
  echo "Need either -i (interactive) or -p \"<prompt>\" (one-shot)." >&2
  usage >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SANDBOX="$REPO/pi-sandbox"
EMIT="$SANDBOX/.pi/components/emit-agent-spec.ts"
SKILL="$SANDBOX/skills/pi-agent-composer"

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY not set; pi cannot call openrouter." >&2
  exit 1
fi

if [[ -z "${TASK_MODEL:-}" && -f "$REPO/models.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO/models.env"; set +a
fi

MODEL="${MODEL_OVERRIDE:-${TASK_MODEL:-}}"
if [[ -z "$MODEL" ]]; then
  echo "No model: pass -m <model> or export TASK_MODEL." >&2
  exit 2
fi

if [[ ! -f "$EMIT" ]]; then
  echo "emit-agent-spec.ts not found at $EMIT." >&2
  exit 2
fi
if [[ ! -d "$SKILL" ]]; then
  echo "pi-agent-composer skill not found at $SKILL." >&2
  exit 2
fi

mkdir -p "$SANDBOX/.pi/agents"

echo ">>> agent-composer model=$MODEL mode=$( [[ $INTERACTIVE -eq 1 ]] && echo interactive || echo one-shot )"
echo "    output=$SANDBOX/.pi/agents/"

if [[ $INTERACTIVE -eq 1 ]]; then
  (
    cd "$SANDBOX"
    exec env \
      PI_SKIP_UPDATE_CHECK=1 \
      PI_SANDBOX_ROOT="$SANDBOX" \
      "$REPO/node_modules/.bin/pi" \
        --no-context-files --no-session --no-skills \
        --provider openrouter --model "$MODEL" \
        --skill "$SKILL" \
        -e "$EMIT" \
        --tools "read,ls,grep,emit_agent_spec"
  )
  exit 0
fi

# One-shot mode. Wrap the prompt to point the LLM at the skill explicitly,
# matching agent-maker's "Use the <skill> skill to: <prompt>." framing.
WRAPPED="Use the pi-agent-composer skill to: ${PROMPT}."
(
  cd "$SANDBOX"
  exec env \
    PI_SKIP_UPDATE_CHECK=1 \
    PI_SANDBOX_ROOT="$SANDBOX" \
    "$REPO/node_modules/.bin/pi" \
      --no-context-files --no-session --no-skills \
      --provider openrouter --model "$MODEL" \
      --skill "$SKILL" \
      -e "$EMIT" \
      --tools "read,ls,grep,emit_agent_spec" \
      --mode json \
      -p "$WRAPPED"
)
