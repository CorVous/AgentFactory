#!/usr/bin/env bash
# agent-composer.sh — drive the pi-agent-composer skill in a tight,
# write-restricted pi spawn whose only output channel is the
# `emit_agent_spec` tool. Output lands at
# pi-sandbox/.pi/agents/<spec.name>.yml after a user-approval gate
# (in-child confirm in -i mode; print-mode -p ALWAYS cancels).
#
# **Mandatory rails.** This script enforces the same cwd-guard /
# sandbox-fs contract that delegate() auto-injects for spawns it
# manages. The contract:
#   - --tools must exclude built-in fs verbs (read|ls|grep|glob|
#     write|edit|bash). The composer's fs surface is exclusively
#     the path-validated sandbox_* family.
#   - The child loads -e <cwd-guard.ts> always and -e <sandbox-fs.ts>
#     whenever a sandbox_* verb appears in --tools.
#   - PI_SANDBOX_ROOT and PI_SANDBOX_VERBS are passed to the child.
# scripts/lib/pi-rails.ts is the single source of truth for that
# contract; this script delegates to it via tsx.
#
# Usage:
#   agent-composer.sh -p "<prompt>"  [-m <model>]
#   agent-composer.sh -i             [-m <model>]
#
# Examples:
#   # -i is the primary entry. The composer is interactive; on a
#   # cancelled emit, the LLM should ask the user what to revise
#   # and re-emit.
#   agent-composer.sh -i
#   agent-composer.sh -i -m google/gemini-3-flash-preview
#
#   # -p is for cancel-path smoke testing only. ctx.ui.confirm is
#   # a no-op that returns false in print mode, so every emit_agent_spec
#   # call cancels — useful for "does the cancel path stay clean?"
#   # but useless for testing the approve path.
#   agent-composer.sh -p "Drafter that stages writes for approval"
#
# The npm wrapper (`npm run agent-composer`) sources models.env first
# so $TASK_MODEL is in scope. Direct invocation needs the same.

set -euo pipefail

INTERACTIVE=0
PROMPT=""
MODEL_OVERRIDE=""

usage() { sed -n '2,40p' "$0"; }

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
RAILS="$REPO/scripts/lib/pi-rails.ts"

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
if [[ ! -f "$RAILS" ]]; then
  echo "pi-rails.ts not found at $RAILS." >&2
  exit 2
fi

mkdir -p "$SANDBOX/.pi/agents"

# Composer tool surface: read-only sandbox verbs + the emit tool.
# Built-in read/ls/grep are excluded — pi-rails.ts asserts that.
TOOLS="sandbox_read,sandbox_ls,sandbox_grep,emit_agent_spec"

# Validate the verb allowlist via the rails helper. Exits non-zero
# with a clear message if a forbidden built-in slips in here.
"$REPO/node_modules/.bin/tsx" "$RAILS" check "$TOOLS"

# Emit the -e flags and env-var assignments for the rails. The
# helper outputs one token per line, so mapfile preserves any
# embedded spaces in paths.
mapfile -t RAILS_ARGS < <(
  "$REPO/node_modules/.bin/tsx" "$RAILS" argv "$SANDBOX" "$TOOLS"
)
mapfile -t RAILS_ENV < <(
  "$REPO/node_modules/.bin/tsx" "$RAILS" env "$SANDBOX" "$TOOLS"
)

echo ">>> agent-composer model=$MODEL mode=$( [[ $INTERACTIVE -eq 1 ]] && echo interactive || echo one-shot )"
echo "    tools=$TOOLS"
echo "    output=$SANDBOX/.pi/agents/"

# Build the env-var prefix list. Each line from `pi-rails env` is
# already in K=V form, so splice directly into `env`.
ENV_ARGS=(PI_SKIP_UPDATE_CHECK=1)
for kv in "${RAILS_ENV[@]}"; do
  ENV_ARGS+=("$kv")
done

if [[ $INTERACTIVE -eq 1 ]]; then
  (
    cd "$SANDBOX"
    exec env \
      "${ENV_ARGS[@]}" \
      "$REPO/node_modules/.bin/pi" \
        --no-context-files --no-session --no-skills \
        --provider openrouter --model "$MODEL" \
        --skill "$SKILL" \
        -e "$EMIT" \
        "${RAILS_ARGS[@]}" \
        --tools "$TOOLS"
  )
  exit 0
fi

# One-shot mode. Wrap the prompt to point the LLM at the skill explicitly.
# Print-mode pi has no UI, so the in-child gate stages and the parent
# (this script's pi) also has no UI — every emit cancels. Use this
# only for cancel-path smoke testing.
WRAPPED="Use the pi-agent-composer skill to: ${PROMPT}."
(
  cd "$SANDBOX"
  exec env \
    "${ENV_ARGS[@]}" \
    "$REPO/node_modules/.bin/pi" \
      --no-context-files --no-session --no-skills \
      --provider openrouter --model "$MODEL" \
      --skill "$SKILL" \
      -e "$EMIT" \
      "${RAILS_ARGS[@]}" \
      --tools "$TOOLS" \
      --mode json \
      -p "$WRAPPED"
)
