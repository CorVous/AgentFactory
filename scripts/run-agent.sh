#!/usr/bin/env bash
# run-agent.sh — interactive launcher for YAML-defined pi agents.
#
# Every YAML spec under pi-sandbox/.pi/agents/*.yml registers a slash
# command via the auto-discovered yaml-agent-runner.ts when pi starts
# in the sandbox cwd. This script opens an interactive pi session
# from the sandbox and (optionally) prints a one-line hint with the
# slash to type for a named agent.
#
# A previous one-shot `pi -p "/<slash>"` dispatch path was removed:
# every gate-bearing emitted agent silently no-ops in print mode
# because `ctx.ui.confirm` returns false unconditionally there.
# Interactive mode is the only sanctioned entry.
#
# Usage:
#   run-agent.sh                         # list available agents and exit
#   run-agent.sh -l | --list             # same
#   run-agent.sh -h | --help             # this help
#   run-agent.sh -i | --interactive [<name>]
#                                        # open interactive pi from the
#                                        # sandbox cwd. When <name> is
#                                        # given, prints a one-line hint
#                                        # with the slash to type;
#                                        # otherwise just opens pi.
#
# Examples:
#   npm run agent                        # list agents and exit
#   npm run agent:i                      # plain pi REPL in sandbox
#   npm run agent:i -- some-emitted      # REPL with /<slash> hint
#
# `<name>` is the YAML filename stem (e.g. `some-emitted` for
# `pi-sandbox/.pi/agents/some-emitted.yml`). The script reads the
# YAML's `slash:` field as the authoritative slash name.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SANDBOX="$REPO/pi-sandbox"
AGENTS_DIR="$SANDBOX/.pi/agents"

usage() { sed -n '2,32p' "$0"; }

INTERACTIVE=0

list_agents() {
  echo "Available agents (open with: npm run agent:i -- <name>):"
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
      break ;;
  esac
done

# No flag, no name → list and exit (the default "what's available" view).
if [[ $INTERACTIVE -eq 0 && -z "$NAME" ]]; then
  list_agents
  exit 0
fi

# A bare name without -i is no longer supported — the one-shot
# dispatch path was removed because gate-bearing agents always
# cancel in print mode. Tell the user to use -i instead.
if [[ $INTERACTIVE -eq 0 && -n "$NAME" ]]; then
  echo "One-shot dispatch was removed (gate-bearing agents cancel" >&2
  echo "in print mode). Use:  npm run agent:i -- $NAME" >&2
  exit 2
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

# Drop into pi from the sandbox cwd. The yaml-agent-runner registers
# every spec's slash command on startup, so the user can type
# `/<slash> <args>` at the prompt. When a name was given, surface the
# exact slash to type as a one-line hint on stderr (stdout is pi's TUI).
if [[ -n "$SLASH" ]]; then
  echo "[run-agent] Interactive mode. Type: /$SLASH <args>" >&2
fi
(
  cd "$SANDBOX"
  exec env \
    PI_SKIP_UPDATE_CHECK=1 \
    "$REPO/node_modules/.bin/pi" \
      --no-context-files \
      --provider openrouter
)
