#!/usr/bin/env bash
# lib/harness.sh — harness plumbing shared across task profiles.
#
# Sourced by grade-task.sh. Before sourcing, the caller must export:
#   LOG    absolute path to the per-model log dir
#   MODEL  model-id string (for the header + grade.json)
#   ART    "$LOG/artifacts" (shortcut; grade-task.sh sets it)
#
# After `discover_artifacts && classify_strays && build_blobs`:
#   EXT_FILES[]   .ts files at extensions/ (+ strays promoted by profile)
#   CHILD_FILES[] .ts files at child-tools/ (+ strays promoted by profile)
#   ALL_FILES[]   union of the two
#   EXT_BLOB      whitespace-collapsed concatenation of EXT_FILES (for regex)
#   ALL_BLOB      whitespace-collapsed concatenation of ALL_FILES
#   LAYOUT_OK=0|1 were artifacts at canonical paths?
#   LAYOUT_NOTE   "|"-joined list of layout mistakes
#
# Scoring:
#   P0_TOTAL/P0_PASS/P1_TOTAL/P1_PASS counters
#   NOTES[] free-form diagnostic strings captured into grade.json
#   mark_p0 / mark_p1 — record a pass/fail bullet AND print it via say
#
# The harness deliberately does NOT score anything — profiles + core-rails
# call mark_p0/mark_p1 themselves so the rubric stays legible at the call
# site instead of hiding inside helper dispatch tables.

# shellcheck shell=bash

EXT_FILES=()
CHILD_FILES=()
STRAY_FILES=()
ALL_FILES=()
EXT_BLOB=""
ALL_BLOB=""
LAYOUT_OK=1
LAYOUT_NOTE=""

P0_TOTAL=0
P0_PASS=0
P1_TOTAL=0
P1_PASS=0
NOTES=()

say() { echo "$@"; }

# grep_any "literal" files... — -F literal search, quiet.
grep_any() {
  local pat="$1"; shift
  if [[ $# -eq 0 ]]; then return 1; fi
  grep -qF -- "$pat" "$@" 2>/dev/null
}

# grep_any_ere "regex" files... — -E extended regex, quiet.
grep_any_ere() {
  local pat="$1"; shift
  if [[ $# -eq 0 ]]; then return 1; fi
  grep -qE -- "$pat" "$@" 2>/dev/null
}

# Blob-scoped helpers for anchors that typically span lines (e.g. an argv
# array split across three lines with stray whitespace).
blob_has()     { [[ "$EXT_BLOB" == *"$1"* ]]; }
blob_has_ere() { echo "$EXT_BLOB" | grep -qE -- "$1"; }

# discover_artifacts — populate *_FILES from $ART subdirs. Must run before
# classify_strays / build_blobs. Missing subdirs are fine (we still grade
# whatever remains).
discover_artifacts() {
  if [[ -d "$ART/extensions" ]]; then
    while IFS= read -r f; do EXT_FILES+=("$f"); done < <(find "$ART/extensions" -type f -name '*.ts' 2>/dev/null)
  fi
  if [[ -d "$ART/child-tools" ]]; then
    while IFS= read -r f; do CHILD_FILES+=("$f"); done < <(find "$ART/child-tools" -type f -name '*.ts' 2>/dev/null)
  fi
  if [[ -d "$ART/stray" ]]; then
    while IFS= read -r f; do STRAY_FILES+=("$f"); done < <(find "$ART/stray" -type f -name '*.ts' 2>/dev/null)
  fi
}

# classify_strays — dispatch each stray .ts through the profile hook
# `profile_classify_stray <file>`, which echoes one of: "ext", "child",
# "ignore". Anything promoted flips LAYOUT_OK to 0 and appends a note.
classify_strays() {
  for f in "${STRAY_FILES[@]}"; do
    local kind
    kind="$(profile_classify_stray "$f")"
    case "$kind" in
      ext)
        EXT_FILES+=("$f")
        LAYOUT_OK=0
        LAYOUT_NOTE="$LAYOUT_NOTE|extension found outside .pi/extensions: ${f#$ART/stray/}"
        ;;
      child)
        CHILD_FILES+=("$f")
        LAYOUT_OK=0
        LAYOUT_NOTE="$LAYOUT_NOTE|child-tool found outside .pi/child-tools: ${f#$ART/stray/}"
        ;;
      ignore|*)
        :
        ;;
    esac
  done
  ALL_FILES=("${EXT_FILES[@]}" "${CHILD_FILES[@]}")
}

build_blobs() {
  if [[ ${#EXT_FILES[@]} -gt 0 ]]; then
    EXT_BLOB=$(cat "${EXT_FILES[@]}" 2>/dev/null | tr '\n' ' ' | tr -s ' ')
  fi
  if [[ ${#ALL_FILES[@]} -gt 0 ]]; then
    ALL_BLOB=$(cat "${ALL_FILES[@]}" 2>/dev/null | tr '\n' ' ' | tr -s ' ')
  fi
}

# emit_artifact_header — print the snapshot summary at the top of grade.md.
emit_artifact_header() {
  say "# Grade — $MODEL"
  say
  say "Artifacts:"
  say "- extensions (+promoted strays): ${#EXT_FILES[@]} file(s)"
  for f in "${EXT_FILES[@]}"; do say "  - ${f#$ART/}"; done
  say "- child-tools (+promoted strays): ${#CHILD_FILES[@]} file(s)"
  for f in "${CHILD_FILES[@]}"; do say "  - ${f#$ART/}"; done
  if [[ $LAYOUT_OK -eq 0 ]]; then
    say "- layout issues:"
    IFS='|' read -ra LAYOUT_MSGS <<< "${LAYOUT_NOTE#|}"
    for m in "${LAYOUT_MSGS[@]}"; do say "  - $m"; done
  fi
  say
}

mark_p0() {
  local name="$1" status="$2" note="${3:-}"
  P0_TOTAL=$((P0_TOTAL+1))
  if [[ "$status" == pass ]]; then
    P0_PASS=$((P0_PASS+1))
    say "- [x] **P0** $name"
  else
    say "- [ ] **P0** $name${note:+ — $note}"
    NOTES+=("P0 miss: $name${note:+ ($note)}")
  fi
}

mark_p1() {
  local name="$1" status="$2" note="${3:-}"
  P1_TOTAL=$((P1_TOTAL+1))
  if [[ "$status" == pass ]]; then
    P1_PASS=$((P1_PASS+1))
    say "- [x] P1 $name"
  else
    say "- [ ] P1 $name${note:+ — $note}"
    NOTES+=("P1 miss: $name${note:+ ($note)}")
  fi
}

# extract_tools_allowlist — echoes the comma-list value passed to --tools,
# or the empty string if not found. Accepts all three TS quoting forms.
# Usage: ALLOW=$(extract_tools_allowlist)
extract_tools_allowlist() {
  [[ -z "$EXT_BLOB" ]] && return 0
  local line
  line=$(echo "$EXT_BLOB" | grep -oE "[\`\"']--tools[\`\"'][^a-zA-Z]+[\`\"'][^\`\"']+[\`\"']|--tools \"[^\"]+\"" | head -1 || true)
  [[ -z "$line" ]] && return 0
  # Last quoted substring is the allowlist (first is `--tools` itself).
  echo "$line" | grep -oE "[\`\"'][^\`\"']+[\`\"']" | tail -1 | tr -d '`"'"'"
}

# extract_cmd_name — echoes the first registerCommand slug found in any
# extension file. Shared across profiles (load+behavioral probes use it).
extract_cmd_name() {
  [[ ${#EXT_FILES[@]} -eq 0 ]] && return 0
  grep -hoE 'registerCommand\(["'\''][a-zA-Z0-9_-]+["'\'']' "${EXT_FILES[@]}" 2>/dev/null \
    | head -1 | sed -E 's/.*\(["'\'']([a-zA-Z0-9_-]+)["'\''].*/\1/'
}

# emit_grade_json — write $JSON with the scoring totals, load/behavioral
# statuses, headline, and NOTES. Status vars are plain strings the caller
# sets (LOAD_STATUS/BEH_STATUS); unset vars render as "skip".
emit_grade_json() {
  local headline="${HEADLINE:-?}"
  local load="${LOAD_STATUS:-skip}"
  local beh="${BEH_STATUS:-skip}"
  {
    printf '{'
    printf '"model": "%s",' "$MODEL"
    printf '"profile": "%s",' "${PROFILE:-unknown}"
    printf '"p0_passed": "%s/%s",' "$P0_PASS" "$P0_TOTAL"
    printf '"p1_passed": "%s/%s",' "$P1_PASS" "$P1_TOTAL"
    printf '"load": "%s",' "$load"
    printf '"behavioral": "%s",' "$beh"
    printf '"headline": "%s",' "$headline"
    printf '"notes": ['
    local first=1
    for n in "${NOTES[@]}"; do
      [[ $first -eq 0 ]] && printf ','
      first=0
      # Minimal JSON escape: quotes + backslashes.
      local esc="${n//\\/\\\\}"; esc="${esc//\"/\\\"}"
      printf '"%s"' "$esc"
    done
    printf ']}'
  } > "$JSON"
}

# headline_for — derive a single-word headline from the counters + statuses.
# Overridable by profiles that want a different rubric (none do today).
headline_for() {
  if [[ ${#EXT_FILES[@]} -eq 0 ]]; then
    echo "no artifacts"
  elif [[ $P0_PASS -eq $P0_TOTAL && "${LOAD_STATUS:-skip}" == "pass" && "${BEH_STATUS:-skip}" == "pass" ]]; then
    echo "full pass"
  elif [[ $P0_PASS -ge $((P0_TOTAL * 3 / 4)) ]]; then
    echo "mostly passing"
  else
    echo "major misses"
  fi
}

emit_summary() {
  say
  say "## Summary"
  say "- P0: $P0_PASS/$P0_TOTAL"
  say "- P1: $P1_PASS/$P1_TOTAL"
  say "- Load: ${LOAD_STATUS:-skip}${LOAD_NOTE:+ (${LOAD_NOTE})}"
  say "- Behavioral: ${BEH_STATUS:-skip}${BEH_NOTE:+ (${BEH_NOTE})}"
  say "- Headline: ${HEADLINE:-?}"
}
