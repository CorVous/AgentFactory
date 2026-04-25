#!/usr/bin/env bash
# run-agent.sh — generic launcher for any YAML-defined pi agent.
#
# Each YAML spec under pi-sandbox/.pi/agents/*.yml declares a slash
# command the auto-discovered yaml-agent-runner.ts registers when pi
# starts in the sandbox. This script reads a chosen spec and opens an
# interactive pi REPL configured AS that agent — same skill, same
# components mounted via `-e`, same tool allowlist — so the user chats
# with the agent's LLM directly. No one-shot dispatch path; for
# scripted runs use the slash inside `npm run pi`, or revive `-p`
# routing here later.
#
# Usage:
#   run-agent.sh                  # list available agents and exit
#   run-agent.sh -l | --list      # same
#   run-agent.sh -h | --help      # this help
#   run-agent.sh <name>           # open interactive pi for that agent
#
# Examples:
#   npm run agent
#   npm run agent agent-composer
#
# `<name>` is the YAML filename stem (e.g. `agent-composer` for
# `pi-sandbox/.pi/agents/agent-composer.yml`).
#
# `agent-maker` is listed for discoverability but kept as a separate
# script (scripts/task-runner/agent-maker.sh) because it needs a
# per-run isolated cwd that the YAML runtime does not currently model.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SANDBOX="$REPO/pi-sandbox"
AGENTS_DIR="$SANDBOX/.pi/agents"

usage() { sed -n '2,28p' "$0"; }

list_agents() {
  echo "Available agents (open interactively: npm run agent <name>):"
  echo
  if [[ -d "$AGENTS_DIR" ]]; then
    local found=0
    for spec in "$AGENTS_DIR"/*.yml "$AGENTS_DIR"/*.yaml; do
      [[ -e "$spec" ]] || continue
      found=1
      local stem slash desc
      stem="$(basename "$spec")"
      stem="${stem%.yml}"
      stem="${stem%.yaml}"
      slash="$(awk -F': *' '/^slash:/ { print $2; exit }' "$spec" | tr -d '"'"'")"
      desc="$(awk -F': *' '/^description:/ { sub(/^description: */, ""); print; exit }' "$spec" | tr -d '"'"'")"
      printf "  %-24s /%s\n" "$stem" "$slash"
      [[ -n "$desc" ]] && printf "    %s\n" "$desc"
    done
    [[ $found -eq 0 ]] && echo "  (no specs found in $AGENTS_DIR)"
  else
    echo "  (no agents directory at $AGENTS_DIR)"
  fi
  echo
  echo "Other agent-builder paths (own scripts):"
  echo "  agent-maker              scripts/task-runner/agent-maker.sh — per-run isolated cwd"
  echo "                           Use: npm run agent-maker -- <task> [-m <model>] [--grade]"
}

NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -l|--list) list_agents; exit 0 ;;
    -*)
      echo "Unknown flag: $1" >&2
      usage >&2
      exit 2 ;;
    *)
      NAME="$1"; shift; break ;;
  esac
done

if [[ -z "$NAME" ]]; then
  list_agents
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "Extra args after agent name aren't supported (interactive only):" >&2
  echo "  ignored: $*" >&2
fi

SPEC="$AGENTS_DIR/$NAME.yml"
[[ -f "$SPEC" ]] || SPEC="$AGENTS_DIR/$NAME.yaml"
if [[ ! -f "$SPEC" ]]; then
  echo "No such agent: $NAME (looked under $AGENTS_DIR)." >&2
  echo "Run 'npm run agent' with no args to see available agents." >&2
  exit 2
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY not set; pi cannot call openrouter." >&2
  exit 1
fi

if [[ -z "${TASK_MODEL:-}" && -f "$REPO/models.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO/models.env"; set +a
fi

# Parse the spec via the tsx helper. Replicates the agent's surface in
# the parent pi: skill, components mounted via -e, tools allowlist.
INFO="$("$REPO/node_modules/.bin/tsx" "$REPO/scripts/yaml-agent-info.ts" "$SPEC")" || {
  echo "Failed to read agent spec: $SPEC" >&2
  exit 2
}
SLASH=""
COMPOSITION=""
SKILL=""
TOOLS=""
COMPONENTS=""
eval "$INFO"

if [[ -z "$SLASH" ]]; then
  echo "Spec is missing a slash field: $SPEC" >&2
  exit 2
fi

if [[ "$COMPOSITION" != "single-spawn" ]]; then
  echo "Only single-spawn agents are runnable interactively (got: $COMPOSITION)." >&2
  echo "Multi-phase agents need scout→draft orchestration that can't run as one REPL." >&2
  exit 2
fi

PI_SKILL_ARGS=()
if [[ -n "$SKILL" ]]; then
  SKILL_ABS="$SANDBOX/$SKILL"
  if [[ ! -d "$SKILL_ABS" ]]; then
    echo "Skill path not found: $SKILL_ABS" >&2
    exit 2
  fi
  # --no-skills + --skill <path> override pattern (proven in
  # scripts/agent-composer.sh:92,110-112): --no-skills suppresses
  # auto-loaded skills, --skill loads the explicit one.
  PI_SKILL_ARGS=(--no-skills --skill "$SKILL_ABS")
fi

PI_EXT_ARGS=()
if [[ -n "$COMPONENTS" ]]; then
  IFS=',' read -ra COMPS <<< "$COMPONENTS"
  for c in "${COMPS[@]}"; do
    COMP_PATH="$SANDBOX/.pi/components/$c.ts"
    if [[ ! -f "$COMP_PATH" ]]; then
      echo "Component file not found: $COMP_PATH" >&2
      exit 2
    fi
    PI_EXT_ARGS+=(-e "$COMP_PATH")
  done
fi

PI_TOOL_ARGS=()
[[ -n "$TOOLS" ]] && PI_TOOL_ARGS=(--tools "$TOOLS")

echo "[run-agent] /$SLASH (skill=${SKILL:-none}, tools=${TOOLS:-default}, components=${COMPONENTS:-none})" >&2
# --no-extensions: the user chats with the agent's LLM directly, so
# auto-discovered slashes (yaml-agent-runner, deferred-writer, etc.)
# are unwanted. The agent's surface comes from --skill, the -e'd
# components, and the --tools allowlist below.
cd "$SANDBOX"
exec env \
  PI_SKIP_UPDATE_CHECK=1 \
  PI_SANDBOX_ROOT="$SANDBOX" \
  "$REPO/node_modules/.bin/pi" \
    --no-context-files --no-session --no-extensions \
    --provider openrouter \
    "${PI_SKILL_ARGS[@]}" \
    "${PI_EXT_ARGS[@]}" \
    "${PI_TOOL_ARGS[@]}"
