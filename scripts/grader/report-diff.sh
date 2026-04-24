#!/usr/bin/env bash
# report-diff.sh — diff two grade.json files produced by the grader.
#
# Usage: report-diff.sh <baseline.json> <current.json>
#
# Emits one markdown row comparing the two rounds on P0 passed-count,
# load status, behavioral status, and headline. Status prefix:
#   ✓ — P0 count equal or up, load/behavioral no worse
#   ⚠ — load or behavioral regressed (pass → partial/fail/skip)
#   ✗ — P0 passed-count regressed
#
# Deliberate scope trim: grade.json has no cost_total_usd / turn_count
# fields today (see scripts/grader/lib/types.ts). A cost/turn diff needs
# the grader extended to accumulate those from the round NDJSON first —
# tracked in parts-first-plan/50-verification-and-ab.md.

set -uo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $(basename "$0") <baseline.json> <current.json>" >&2
  exit 2
fi

baseline="$1"
current="$2"

for f in "$baseline" "$current"; do
  [[ -f "$f" ]] || { echo "not found: $f" >&2; exit 2; }
done

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi

# Helpers — jq quote-safe extraction with defaults.
get() { jq -r "$1 // \"\"" "$2"; }
p0_count() { jq -r '(.p0_passed // "0/0") | split("/")[0] | tonumber? // 0' "$1"; }

# Status ordering: pass(3) > partial(2) > skip(1) > fail(0). Anything
# moving down the ladder is a regression.
status_rank() {
  case "$1" in
    pass)    echo 3 ;;
    partial) echo 2 ;;
    skip)    echo 1 ;;
    fail)    echo 0 ;;
    *)       echo 0 ;;
  esac
}

bP0=$(p0_count "$baseline")
cP0=$(p0_count "$current")
bLoad=$(get '.load'       "$baseline"); cLoad=$(get '.load'       "$current")
bBeh=$(get  '.behavioral' "$baseline"); cBeh=$(get  '.behavioral' "$current")
cHead=$(get '.headline'   "$current")

task=$(get '.task'  "$current")
model=$(get '.model' "$current")
skill=$(get '.skill' "$current")

p0Delta=$((cP0 - bP0))
loadRegressed=0
[[ $(status_rank "$cLoad") -lt $(status_rank "$bLoad") ]] && loadRegressed=1
behRegressed=0
[[ $(status_rank "$cBeh")  -lt $(status_rank "$bBeh")  ]] && behRegressed=1

if   [[ $p0Delta -lt 0 ]]; then flag="✗"
elif [[ $loadRegressed -eq 1 || $behRegressed -eq 1 ]]; then flag="⚠"
else flag="✓"
fi

printf '| %s | %s | %s | %s | %s→%s | %s→%s | %+d | %s |\n' \
  "$flag" "$task" "$model" "$skill" "$bLoad" "$cLoad" "$bBeh" "$cBeh" "$p0Delta" "$cHead"
