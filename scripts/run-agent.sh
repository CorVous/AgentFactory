#!/usr/bin/env bash
# run-agent.sh — generic launcher for any YAML-defined pi agent.
#
# Every YAML spec under pi-sandbox/.pi/agents/*.yml registers a slash
# command via the auto-discovered yaml-agent-runner.ts when pi starts
# in the sandbox cwd. This script gives those agents a one-shot script
# form by forwarding to `pi -p "/<slash> <args>"` from inside the
# sandbox. Agents already reachable interactively as `/<slash>` from
# `npm run pi` thus also become reachable from a single CLI call.
#
# Usage:
#   run-agent.sh                    # list available agents and exit
#   run-agent.sh -l | --list        # same
#   run-agent.sh -h | --help        # this help
#   run-agent.sh <name> [args...]   # dispatch one-shot
#
# Examples:
#   npm run agent
#   npm run agent -- agent-composer "Drafter that stages writes for approval"
#
# `<name>` is the YAML filename stem (e.g. `agent-composer` for
# `pi-sandbox/.pi/agents/agent-composer.yml`). The script reads the
# YAML's `slash:` field as the authoritative slash name.
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
  echo "Available agents (script form: npm run agent -- <name> [args]):"
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

if [[ $# -eq 0 ]]; then
  list_agents
  exit 0
fi

case "$1" in
  -h|--help) usage; exit 0 ;;
  -l|--list) list_agents; exit 0 ;;
  -*)
    echo "Unknown flag: $1" >&2
    usage >&2
    exit 2 ;;
esac

NAME="$1"
shift

SPEC="$AGENTS_DIR/$NAME.yml"
if [[ ! -f "$SPEC" ]]; then
  SPEC="$AGENTS_DIR/$NAME.yaml"
fi
if [[ ! -f "$SPEC" ]]; then
  echo "No such agent: $NAME (looked under $AGENTS_DIR)." >&2
  echo "Run 'npm run agent' with no args to see available agents." >&2
  exit 2
fi

SLASH="$(awk -F': *' '/^slash:/ { print $2; exit }' "$SPEC" | tr -d '"'"'")"
if [[ -z "$SLASH" ]]; then
  echo "Couldn't parse 'slash:' field from $SPEC." >&2
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

# Compose the prompt: "/<slash> <args joined>". Empty args yield "/<slash>",
# which the runner's handler intercepts with a usage notify and exits.
PROMPT="/$SLASH"
if [[ $# -gt 0 ]]; then
  PROMPT="$PROMPT $*"
fi

(
  cd "$SANDBOX"
  exec env \
    PI_SKIP_UPDATE_CHECK=1 \
    "$REPO/node_modules/.bin/pi" \
      --no-context-files --no-session \
      --mode json \
      -p "$PROMPT"
)
