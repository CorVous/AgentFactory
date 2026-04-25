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
#   run-agent.sh                       # list available agents and exit
#   run-agent.sh -l | --list           # same
#   run-agent.sh -h | --help           # this help
#   run-agent.sh <name> [args...]      # dispatch one-shot (script form)
#   run-agent.sh -i | --interactive [<name>]
#                                      # open interactive pi from the
#                                      # sandbox cwd. When <name> is given,
#                                      # prints a hint about the slash to
#                                      # type; otherwise just opens pi.
#
# Examples:
#   npm run agent
#   npm run agent -- agent-composer "Drafter that stages writes for approval"
#   npm run agent:i                                  # plain pi REPL
#   npm run agent:i -- agent-composer                # REPL with hint
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
RUNNER_PATH="$SANDBOX/.pi/extensions/yaml-agent-runner.ts"

usage() { sed -n '2,32p' "$0"; }

INTERACTIVE=0

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

NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -l|--list) list_agents; exit 0 ;;
    -i|--interactive) INTERACTIVE=1; shift ;;
    -*)
      echo "Unknown flag: $1" >&2
      usage >&2
      exit 2 ;;
    *)
      NAME="$1"; shift
      break ;;  # everything after the name is forwarded as args
  esac
done

# No flag, no name → list and exit (the default "what's available" view).
if [[ $INTERACTIVE -eq 0 && -z "$NAME" ]]; then
  list_agents
  exit 0
fi

SLASH=""
if [[ -n "$NAME" ]]; then
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
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY not set; pi cannot call openrouter." >&2
  exit 1
fi

if [[ -z "${TASK_MODEL:-}" && -f "$REPO/models.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO/models.env"; set +a
fi

if [[ $INTERACTIVE -eq 1 && -z "$NAME" ]]; then
  # No name → open pi from the sandbox cwd with only yaml-agent-runner
  # explicitly loaded. `--no-extensions` suppresses auto-discovery of
  # the legacy deferred-writer / delegated-writer extensions; `-e`
  # re-adds the runner so the YAML-defined slash commands are still
  # available. `exec` replaces this script's process with pi.
  cd "$SANDBOX"
  exec env \
    PI_SKIP_UPDATE_CHECK=1 \
    "$REPO/node_modules/.bin/pi" \
      --no-context-files \
      --no-extensions \
      -e "$RUNNER_PATH" \
      --provider openrouter
fi

if [[ $INTERACTIVE -eq 1 ]]; then
  # With a name, replicate the agent's surface in the parent pi session:
  # load the YAML's skill, mount its components via -e, apply its tools
  # allowlist. This makes `agent:i <name>` feel like the agent rather
  # than just "pi from the sandbox where the slash happens to be
  # registered". Same shape as scripts/agent-composer.sh -i, but driven
  # by the YAML instead of hardcoded.
  INFO="$("$REPO/node_modules/.bin/tsx" "$REPO/scripts/yaml-agent-info.ts" "$SPEC")" || {
    echo "Failed to read agent spec: $SPEC" >&2
    exit 2
  }
  COMPOSITION=""
  SKILL=""
  TOOLS=""
  COMPONENTS=""
  eval "$INFO"

  if [[ "$COMPOSITION" != "single-spawn" ]]; then
    echo "Interactive mode supports single-spawn agents only (got: $COMPOSITION)." >&2
    echo "For multi-phase agents use one-shot: npm run agent -- $NAME <task>" >&2
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

  echo "[run-agent] Interactive /$SLASH (skill=${SKILL:-none}, tools=${TOOLS:-default}, components=${COMPONENTS:-none})" >&2
  # --no-extensions: the user chats with the agent's LLM directly, so
  # auto-discovered slashes (yaml-agent-runner, deferred-writer, etc.)
  # are unwanted. The agent's own surface comes from --skill, the -e'd
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
fi

# Compose the prompt: "/<slash> <args joined>". Empty args yield "/<slash>",
# which the runner's handler intercepts with a usage notify and exits.
PROMPT="/$SLASH"
if [[ $# -gt 0 ]]; then
  PROMPT="$PROMPT $*"
fi

(
  cd "$SANDBOX"
  # --no-extensions + explicit -e on yaml-agent-runner: the parent only
  # needs the runner to recognize the slash and dispatch via delegate;
  # the actual worker is the dispatched child (which gets its own
  # --no-extensions from delegate.ts). Suppresses unrelated auto-loaded
  # extensions in the parent.
  exec env \
    PI_SKIP_UPDATE_CHECK=1 \
    "$REPO/node_modules/.bin/pi" \
      --no-context-files --no-session --no-extensions \
      -e "$RUNNER_PATH" \
      --mode json \
      -p "$PROMPT"
)
