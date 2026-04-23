#!/usr/bin/env bash
# grade-deferred-writer.sh
#
# Grade one model's artifacts against scripts/deferred-writer-rubric.md.
#
# Usage:  scripts/grade-deferred-writer.sh <log-dir> <model-id>
# Inputs: <log-dir>/artifacts/extensions/, <log-dir>/artifacts/child-tools/
# Outputs: stdout = human markdown; <log-dir>/grade.json = machine-readable.

set -uo pipefail

LOG="${1:?log dir required}"
MODEL="${2:?model id required}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="$REPO/pi-sandbox"
# Force LOG to an absolute path — the behavioral probe cds into the sandbox,
# and any relative redirect would then resolve there, not under the log dir.
LOG="$(cd "$LOG" && pwd)"
ART="$LOG/artifacts"
JSON="$LOG/grade.json"

# Ensure model tier vars are available for the behavioral probe even when
# the grader is invoked standalone.
if [[ -z "${TASK_MODEL:-}" && -f "$REPO/models.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO/models.env"; set +a
fi

EXT_FILES=()
CHILD_FILES=()
STRAY_FILES=()
if [[ -d "$ART/extensions" ]]; then
  while IFS= read -r f; do EXT_FILES+=("$f"); done < <(find "$ART/extensions" -type f -name '*.ts' 2>/dev/null)
fi
if [[ -d "$ART/child-tools" ]]; then
  while IFS= read -r f; do CHILD_FILES+=("$f"); done < <(find "$ART/child-tools" -type f -name '*.ts' 2>/dev/null)
fi
if [[ -d "$ART/stray" ]]; then
  while IFS= read -r f; do STRAY_FILES+=("$f"); done < <(find "$ART/stray" -type f -name '*.ts' 2>/dev/null)
fi

# Classify strays: any stray with registerCommand -> promote to EXT_FILES;
# any with registerTool + stage_write -> promote to CHILD_FILES. This lets
# us grade the content even when the model picked wrong paths. The
# "layout" check below separately records the placement mistake.
LAYOUT_OK=1
LAYOUT_NOTE=""
for f in "${STRAY_FILES[@]}"; do
  if grep -q "registerCommand" "$f" 2>/dev/null; then
    EXT_FILES+=("$f")
    LAYOUT_OK=0
    LAYOUT_NOTE="$LAYOUT_NOTE|extension found outside .pi/extensions: ${f#$ART/stray/}"
  elif grep -q "registerTool" "$f" 2>/dev/null && grep -q "stage_write\|stage-write" "$f" 2>/dev/null; then
    CHILD_FILES+=("$f")
    LAYOUT_OK=0
    LAYOUT_NOTE="$LAYOUT_NOTE|child-tool found outside .pi/child-tools: ${f#$ART/stray/}"
  fi
done

ALL_FILES=("${EXT_FILES[@]}" "${CHILD_FILES[@]}")

# Build whitespace-collapsed blobs. Many anchors below are syntactic
# constructs that models frequently split across lines (e.g.
# `"--tools",\n"stage_write,ls"`). Line-local grep misses those.
EXT_BLOB=""
ALL_BLOB=""
if [[ ${#EXT_FILES[@]} -gt 0 ]]; then
  EXT_BLOB=$(cat "${EXT_FILES[@]}" 2>/dev/null | tr '\n' ' ' | tr -s ' ')
fi
if [[ ${#ALL_FILES[@]} -gt 0 ]]; then
  ALL_BLOB=$(cat "${ALL_FILES[@]}" 2>/dev/null | tr '\n' ' ' | tr -s ' ')
fi
blob_has() { [[ "$EXT_BLOB" == *"$1"* ]]; }
blob_has_ere() { echo "$EXT_BLOB" | grep -qE -- "$1"; }

say() { echo "$@"; }
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

P0_TOTAL=0 P0_PASS=0
P1_TOTAL=0 P1_PASS=0
declare -a NOTES=()

# --- helpers -----------------------------------------------------------------
grep_any() {
  # grep_any "pattern" files...
  local pat="$1"; shift
  if [[ $# -eq 0 ]]; then return 1; fi
  grep -qF -- "$pat" "$@" 2>/dev/null
}
grep_any_ere() {
  local pat="$1"; shift
  if [[ $# -eq 0 ]]; then return 1; fi
  grep -qE -- "$pat" "$@" 2>/dev/null
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

# --- structural --------------------------------------------------------------
say "## Structural"
if [[ ${#EXT_FILES[@]} -ge 1 && ${#CHILD_FILES[@]} -ge 1 ]]; then
  mark_p0 "Two files produced (extension + child-tool)" pass
elif [[ ${#EXT_FILES[@]} -ge 1 ]]; then
  mark_p0 "Two files produced (extension + child-tool)" fail "child-tool missing"
elif [[ ${#CHILD_FILES[@]} -ge 1 ]]; then
  mark_p0 "Two files produced (extension + child-tool)" fail "extension missing"
else
  mark_p0 "Two files produced (extension + child-tool)" fail "no .ts output at all"
fi

# Layout: are the files at the canonical paths (pi-sandbox/.pi/extensions
# and .pi/child-tools), or did the model write them elsewhere?
if [[ $LAYOUT_OK -eq 1 && (${#EXT_FILES[@]} -gt 0 || ${#CHILD_FILES[@]} -gt 0) ]]; then
  mark_p0 "files placed at canonical .pi/extensions + .pi/child-tools paths" pass
elif [[ ${#EXT_FILES[@]} -gt 0 || ${#CHILD_FILES[@]} -gt 0 ]]; then
  mark_p0 "files placed at canonical .pi/extensions + .pi/child-tools paths" fail "files ended up in stray locations"
else
  mark_p0 "files placed at canonical .pi/extensions + .pi/child-tools paths" fail "no files produced"
fi

if [[ ${#EXT_FILES[@]} -eq 0 && ${#CHILD_FILES[@]} -eq 0 ]]; then
  # With no artifacts, everything else is a fail — emit compact summary and exit.
  cat > "$JSON" <<EOF
{
  "model": "$MODEL",
  "p0_passed": "0/$P0_TOTAL",
  "p1_passed": "0/0",
  "load": "skip",
  "behavioral": "skip",
  "headline": "no artifacts produced",
  "notes": ["no .ts output"]
}
EOF
  exit 0
fi

if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any_ere "pi\.registerCommand\(['\"]" "${EXT_FILES[@]}"; then
  mark_p0 "registerCommand in extension" pass
else
  mark_p0 "registerCommand in extension" fail
fi

# Extract the actual registered slash command name for later probes.
# The rubric intentionally does NOT grade the name itself — any slug is fine.
CMD_NAME=""
if [[ ${#EXT_FILES[@]} -gt 0 ]]; then
  CMD_NAME=$(grep -hoE 'registerCommand\(["'\''][a-zA-Z0-9_-]+["'\'']' "${EXT_FILES[@]}" 2>/dev/null \
    | head -1 | sed -E 's/.*\(["'\'']([a-zA-Z0-9_-]+)["'\''].*/\1/')
fi
if [[ -n "$CMD_NAME" ]]; then
  say "- registered slash command: \`/$CMD_NAME\`"
else
  say "- [warn] could not extract registered slash command name"
fi

if [[ ${#CHILD_FILES[@]} -gt 0 ]] && grep_any "stage_write" "${CHILD_FILES[@]}"; then
  mark_p0 "stage_write tool defined in child-tool file" pass
else
  # Some models may emit one monolithic extension — count that as a partial fail.
  if [[ ${#ALL_FILES[@]} -gt 0 ]] && grep_any "stage_write" "${ALL_FILES[@]}"; then
    mark_p0 "stage_write tool defined in child-tool file" fail "found elsewhere, not in child-tools/"
  else
    mark_p0 "stage_write tool defined in child-tool file" fail "stage_write not found anywhere"
  fi
fi

if [[ ${#ALL_FILES[@]} -gt 0 ]] && grep_any_ere "registerTool\(" "${ALL_FILES[@]}" && grep_any "details" "${ALL_FILES[@]}"; then
  mark_p0 "registerTool returns {content, details}" pass
else
  mark_p0 "registerTool returns {content, details}" fail
fi

# --- subprocess rails --------------------------------------------------------
say "## Subprocess rails"
if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any_ere -- '--no-extensions|"-ne"' "${EXT_FILES[@]}"; then
  mark_p0 "--no-extensions on spawn" pass
else
  mark_p0 "--no-extensions on spawn" fail
fi

if blob_has_ere '[`"'\'']--mode[`"'\''][^a-zA-Z]+[`"'\'']json[`"'\'']|--mode json'; then
  mark_p0 "--mode json on spawn" pass
else
  mark_p0 "--mode json on spawn" fail
fi

TOOLS_LINE=""
if [[ -n "$EXT_BLOB" ]]; then
  # Accept --tools followed by the allowlist in double-quotes, backticks,
  # or single-quotes — all three forms are common in TS.
  TOOLS_LINE=$(echo "$EXT_BLOB" | grep -oE "[\`\"']--tools[\`\"'][^a-zA-Z]+[\`\"'][^\`\"']+[\`\"']|--tools \"[^\"]+\"" | head -1 || true)
fi
if [[ -n "$TOOLS_LINE" ]]; then
  # Extract the allowlist value — it follows `--tools` and can be in
  # double-quotes, backticks, or single-quotes. Keep only the last
  # quoted substring of the match (the first is `--tools` itself).
  ALLOWLIST=$(echo "$TOOLS_LINE" | grep -oE "[\`\"'][^\`\"']+[\`\"']" | tail -1 | tr -d '`"'"'")
  # Required: stage_write. Forbidden: write, edit, bash, grep, glob, read (per user direction).
  if [[ ",$ALLOWLIST," == *",stage_write,"* ]]; then
    if [[ ",$ALLOWLIST," == *",write,"* || ",$ALLOWLIST," == *",edit,"* || ",$ALLOWLIST," == *",bash,"* || ",$ALLOWLIST," == *",grep,"* || ",$ALLOWLIST," == *",glob,"* || ",$ALLOWLIST," == *",read,"* ]]; then
      mark_p0 "--tools allowlist is stage_write (+ls) only, no read/write/bash/etc" fail "got: $ALLOWLIST"
    else
      mark_p0 "--tools allowlist is stage_write (+ls) only, no read/write/bash/etc" pass
    fi
  else
    mark_p0 "--tools allowlist is stage_write (+ls) only, no read/write/bash/etc" fail "stage_write not in allowlist: $ALLOWLIST"
  fi
else
  mark_p0 "--tools allowlist is stage_write (+ls) only, no read/write/bash/etc" fail "no --tools flag found"
fi

if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "openrouter" "${EXT_FILES[@]}" && grep_any "process.env." "${EXT_FILES[@]}"; then
  mark_p0 "--provider openrouter + --model from env" pass
else
  mark_p0 "--provider openrouter + --model from env" fail
fi

if blob_has_ere 'stdio: *\[ *"ignore"'; then
  mark_p0 'stdio: ["ignore", "pipe", "pipe"]' pass
else
  mark_p0 'stdio: ["ignore", "pipe", "pipe"]' fail
fi

if blob_has "path.resolve(process.cwd())" && blob_has_ere 'cwd:[[:space:]]*[a-zA-Z_]'; then
  mark_p0 "sandboxRoot captured + cwd pinned on spawn" pass
else
  mark_p0 "sandboxRoot captured + cwd pinned on spawn" fail
fi

if blob_has "setTimeout(" && blob_has_ere 'SIGKILL|child\.kill\(|childProcess\.kill\('; then
  mark_p0 "hard timeout + SIGKILL on child" pass
else
  mark_p0 "hard timeout + SIGKILL on child" fail
fi

# --- harvest + validate ------------------------------------------------------
say "## Harvest + validate"
if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "tool_execution_start" "${EXT_FILES[@]}" && grep_any "JSON.parse(" "${EXT_FILES[@]}"; then
  mark_p0 "NDJSON parsed line-by-line for tool_execution_start" pass
else
  mark_p0 "NDJSON parsed line-by-line for tool_execution_start" fail
fi

HARVEST_FIELD_OK=1
if [[ -n "$EXT_BLOB" ]]; then
  # Accept: e.args.path/content, args.path/content, event.args.path/content,
  # destructuring `= event.args` or `= e.args`, or `inputObj = e.args`.
  if blob_has_ere '(e|event)\.args\.(path|content)|args\.(path|content)|= *(e|event)\.args|= *inputObj' \
     || blob_has "= event.args" || blob_has "= e.args"; then
    :
  else
    HARVEST_FIELD_OK=0
  fi
  if blob_has "toolCall.input"; then
    HARVEST_FIELD_OK=0
  fi
else
  HARVEST_FIELD_OK=0
fi
if [[ $HARVEST_FIELD_OK == 1 ]]; then
  mark_p0 "harvest from e.args.path/content (not e.toolCall.input)" pass
else
  mark_p0 "harvest from e.args.path/content (not e.toolCall.input)" fail
fi

if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any_ere 'path\.isAbsolute|isAbsolute\(' "${EXT_FILES[@]}" && grep_any "fs.existsSync" "${EXT_FILES[@]}" && grep_any_ere '\.\.\"|"\.\."' "${EXT_FILES[@]}"; then
  mark_p0 "path validation (absolute / .. / exists)" pass
else
  mark_p0 "path validation (absolute / .. / exists)" fail
fi

if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any_ere 'startsWith\(sandboxRoot|startsWith\([a-zA-Z_]+ \+ path\.sep\)' "${EXT_FILES[@]}"; then
  mark_p0 "sandbox-root escape check (startsWith)" pass
else
  mark_p0 "sandbox-root escape check (startsWith)" fail
fi

# --- approval + promote ------------------------------------------------------
say "## Approval + promote"
if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "ctx.ui.confirm" "${EXT_FILES[@]}"; then
  mark_p0 "ctx.ui.confirm) before disk write" pass
else
  mark_p0 "ctx.ui.confirm) before disk write" fail
fi

if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "fs.writeFileSync(" "${EXT_FILES[@]}" && grep_any_ere 'fs\.mkdirSync\(.*recursive.*true' "${EXT_FILES[@]}"; then
  mark_p0 "fs.writeFileSync + mkdirSync recursive on promote" pass
else
  mark_p0 "fs.writeFileSync + mkdirSync recursive on promote" fail
fi

# --- P1 polish ---------------------------------------------------------------
say "## P1 polish"
if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any_ere '\.slice\(0, *[0-9]+\)' "${EXT_FILES[@]}"; then
  mark_p1 "notify truncation" pass
else
  mark_p1 "notify truncation" fail
fi

if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "createHash(\"sha256\")" "${EXT_FILES[@]}"; then
  mark_p1 "sha256 post-write verify" pass
else
  # Lesser alternative: a second fs.existsSync in the promote loop.
  if [[ ${#EXT_FILES[@]} -gt 0 ]] && [[ $(grep -cH "fs.existsSync" "${EXT_FILES[@]}" 2>/dev/null | awk -F: '{s+=$NF} END{print s+0}') -ge 2 ]]; then
    mark_p1 "sha256 post-write verify" pass "substituted by double existsSync check"
  else
    mark_p1 "sha256 post-write verify" fail
  fi
fi

if blob_has_ere '[`"'\'']--thinking[`"'\''][^a-zA-Z]+[`"'\'']off[`"'\'']|--thinking off' && blob_has "--no-session"; then
  mark_p1 "--thinking off + --no-session on drafter" pass
else
  mark_p1 "--thinking off + --no-session on drafter" fail
fi

NOTIFY_COUNT=0
if [[ ${#EXT_FILES[@]} -gt 0 ]]; then
  # grep -c with multiple files prints "file:N" per file; with a single file
  # it prints just "N". Use -H to force the "file:N" form, then sum.
  NOTIFY_COUNT=$(grep -cH "ctx.ui.notify" "${EXT_FILES[@]}" 2>/dev/null | awk -F: '{s+=$NF} END{print s+0}')
fi
if [[ $NOTIFY_COUNT -ge 4 ]]; then
  mark_p1 "notifies at phase boundaries (>=4 calls)" pass "$NOTIFY_COUNT calls"
else
  mark_p1 "notifies at phase boundaries (>=4 calls)" fail "$NOTIFY_COUNT calls"
fi

# --- negative anchors --------------------------------------------------------
say "## Negative anchors"
if [[ ${#ALL_FILES[@]} -gt 0 ]] && grep_any "console.log" "${ALL_FILES[@]}"; then
  NOTES+=("warn: console.log present (TUI anti-pattern)")
  say "- [!] console.log present (anti-pattern)"
fi

# --- load smoke --------------------------------------------------------------
say "## Load smoke"
LOAD_STATUS="skip"
LOAD_NOTE=""
if [[ "${SKIP_LOAD:-0}" == "1" ]]; then
  LOAD_STATUS="skip"
  LOAD_NOTE="SKIP_LOAD=1"
  say "- [-] skipped (SKIP_LOAD=1)"
elif [[ ${#EXT_FILES[@]} -gt 0 && -n "$CMD_NAME" ]]; then
  # Probe: invoke "/<CMD_NAME>" with no args via pi -p. When the command
  # is registered, agent-session.js short-circuits in
  # _tryExecuteExtensionCommand and NO agent_start / message_* events
  # fire — only the session header appears on stdout. When the command is
  # NOT registered, pi sends the text to the LLM and emits ~dozens of
  # message_update events. We count event types and decide.
  EXT_FILE="${EXT_FILES[0]}"
  set +e
  # TASK_MODEL fallback so the extension's env-check doesn't abort the
  # handler before registration is confirmed (we still won't reach any
  # network call because confirm returns false in print mode, and
  # --no-tools prevents any spawn).
  TASK_MODEL_FOR_LOAD="${TASK_MODEL:-anthropic/claude-haiku-4.5}"
  # Prepend node_modules/.bin to PATH so extension-level `spawn("pi", ...)`
  # calls resolve the binary. The reference extension does this too; under
  # `npm run pi` npm sets PATH, but we invoke pi directly and have to
  # replicate the setup.
  timeout 30s env PI_SKIP_UPDATE_CHECK=1 TASK_MODEL="$TASK_MODEL_FOR_LOAD" \
    PATH="$REPO/node_modules/.bin:$PATH" \
    "$REPO/node_modules/.bin/pi" \
      --no-context-files --no-session --no-skills --no-extensions \
      -e "$EXT_FILE" \
      --mode json --no-tools \
      --provider openrouter --model "$TASK_MODEL_FOR_LOAD" \
      -p "/$CMD_NAME" \
      > "$LOG/load.ndjson" 2> "$LOG/load.stderr"
  LOAD_EXIT=$?
  set -e
  # Count event types. A registered command gives ~1 event (session).
  # An unregistered command gives many (turn_start/message_*/agent_end).
  EVT_COUNT=$(wc -l < "$LOG/load.ndjson" 2>/dev/null | awk '{print $1+0}')
  SAW_AGENT_START=$(grep -c '"type":"agent_start"' "$LOG/load.ndjson" 2>/dev/null; true)
  SAW_AGENT_START="${SAW_AGENT_START:-0}"
  if [[ $LOAD_EXIT -eq 0 && $SAW_AGENT_START -eq 0 && ${EVT_COUNT:-0} -ge 1 && ${EVT_COUNT:-0} -le 3 ]]; then
    LOAD_STATUS="pass"
    say "- [x] command /$CMD_NAME registered (no LLM call)"
  elif [[ $LOAD_EXIT -ne 0 && $SAW_AGENT_START -eq 0 && ${EVT_COUNT:-0} -ge 1 && ${EVT_COUNT:-0} -le 3 ]]; then
    # Command was registered and dispatched — pi emitted the session
    # header and short-circuited the slash command — but the handler
    # exited nonzero. Registration is fine; the handler has a bug.
    LOAD_STATUS="partial"
    LOAD_NOTE="command registered but handler didn't short-circuit on empty args (exit $LOAD_EXIT)"
    say "- [~] command /$CMD_NAME registered, but handler ran heavy work on empty args (exit $LOAD_EXIT)"
  elif [[ ${EVT_COUNT:-0} -eq 0 ]]; then
    # Zero events means pi never emitted the session header — the
    # extension failed to load (parse error, unresolved import, top-
    # level throw). That's not a registration issue; the extension
    # code itself is broken.
    LOAD_STATUS="fail"
    STDERR_TAIL=$(tail -5 "$LOG/load.stderr" 2>/dev/null | tr -d '\n' | head -c 200)
    LOAD_NOTE="extension failed to load: $STDERR_TAIL"
    say "- [ ] extension failed to load — 0 events emitted"
    [[ -n "$STDERR_TAIL" ]] && say "      stderr: $STDERR_TAIL"
  elif [[ $LOAD_EXIT -eq 0 && $SAW_AGENT_START -ge 1 ]]; then
    LOAD_STATUS="fail"
    LOAD_NOTE="extension loaded but /$CMD_NAME was not registered (went to LLM)"
    say "- [ ] command /$CMD_NAME not registered — went to LLM"
  elif [[ $LOAD_EXIT -ne 0 ]]; then
    LOAD_STATUS="fail"
    LOAD_NOTE="pi exit $LOAD_EXIT on load (see load.stderr)"
    say "- [ ] fails to load — exit $LOAD_EXIT"
    STDERR_TAIL=$(tail -5 "$LOG/load.stderr" 2>/dev/null | tr -d '\n' | head -c 200)
    [[ -n "$STDERR_TAIL" ]] && say "      stderr: $STDERR_TAIL"
  else
    LOAD_STATUS="partial"
    LOAD_NOTE="ambiguous — events=$EVT_COUNT agent_start=$SAW_AGENT_START"
    say "- [~] ambiguous (events=$EVT_COUNT agent_start=$SAW_AGENT_START)"
  fi
elif [[ -z "$CMD_NAME" ]]; then
  LOAD_STATUS="fail"
  LOAD_NOTE="could not extract registered command name from extension"
  say "- [ ] skipped (no CMD_NAME found in extension)"
else
  say "- [ ] skipped (no extension file)"
fi

# --- behavioral smoke --------------------------------------------------------
say "## Behavioral smoke"
BEH_STATUS="skip"
BEH_NOTE=""
if [[ "${SKIP_BEH:-0}" == "1" ]]; then
  BEH_STATUS="skip"
  BEH_NOTE="SKIP_BEH=1"
  say "- [-] skipped (SKIP_BEH=1)"
elif [[ $LOAD_STATUS == "pass" || $LOAD_STATUS == "partial" ]]; then
  # Inject artifacts into the real sandbox, run /deferred-writer, then clean up.
  TMP_RUN_DIR="$LOG/tmp-behavior"
  rm -rf "$TMP_RUN_DIR"
  mkdir -p "$TMP_RUN_DIR"
  # Place artifacts back into sandbox .pi/ dirs for this run.
  rm -rf "$SANDBOX/.pi/extensions"/* "$SANDBOX/.pi/child-tools"/* 2>/dev/null || true
  cp -a "$ART/extensions/." "$SANDBOX/.pi/extensions/" 2>/dev/null || true
  cp -a "$ART/child-tools/." "$SANDBOX/.pi/child-tools/" 2>/dev/null || true

  set +e
  (
    cd "$SANDBOX"
    timeout 180s env PI_SKIP_UPDATE_CHECK=1 \
      PATH="$REPO/node_modules/.bin:$PATH" \
      "$REPO/node_modules/.bin/pi" \
        --no-context-files --no-session --no-skills \
        --provider openrouter --model "$TASK_MODEL" \
        --mode json \
        -p "/$CMD_NAME create a file hello-probe.md with the text hi" \
        > "$LOG/behavior.ndjson" 2> "$LOG/behavior.stderr"
  )
  BEH_EXIT=$?
  set -e

  # Clean up any probe file the extension may have managed to write despite
  # ctx.ui.confirm returning false (shouldn't happen; defensive).
  rm -f "$SANDBOX/hello-probe.md" 2>/dev/null || true
  # Wipe the injected artifacts to leave the sandbox clean for the next pass.
  rm -rf "$SANDBOX/.pi/extensions"/* "$SANDBOX/.pi/child-tools"/* 2>/dev/null || true

  # Observability caveat: ctx.ui.notify is a no-op in print mode, so we
  # cannot directly see whether the child pi fired stage_write — its
  # NDJSON flows into the extension's parser, not onto our stdout. The
  # outer NDJSON only ever shows the `session` header for a registered
  # command. So the behavioral pass/fail distinguishes: did the handler
  # run end-to-end without crashing (exit 0), did it timeout (124), or
  # did it throw (>0). An async-cleanup bug shows up as a nonzero exit
  # even though stdout looks clean.
  EVT_COUNT_BH=0
  SAW_AGENT_START_BH=0
  if [[ -f "$LOG/behavior.ndjson" ]]; then
    EVT_COUNT_BH=$(wc -l < "$LOG/behavior.ndjson" 2>/dev/null | awk '{print $1+0}')
    SAW_AGENT_START_BH=$(grep -c '"type":"agent_start"' "$LOG/behavior.ndjson" 2>/dev/null; true)
    SAW_AGENT_START_BH="${SAW_AGENT_START_BH:-0}"
  fi

  if [[ $BEH_EXIT -eq 0 && $SAW_AGENT_START_BH -eq 0 && ${EVT_COUNT_BH:-0} -le 3 ]]; then
    BEH_STATUS="pass"
    say "- [x] exit 0; handler ran, dispatched + cancelled cleanly"
  elif [[ $BEH_EXIT -eq 0 && $SAW_AGENT_START_BH -ge 1 ]]; then
    BEH_STATUS="fail"
    BEH_NOTE="command not registered — /cmd went to LLM instead of handler"
    say "- [ ] command not registered (went to LLM)"
  elif [[ $BEH_EXIT -eq 124 ]]; then
    BEH_STATUS="fail"
    BEH_NOTE="timed out after 180s (hang)"
    say "- [ ] timed out — hang"
  elif [[ $BEH_EXIT -ne 0 ]]; then
    BEH_STATUS="fail"
    STDERR_TAIL=$(tail -3 "$LOG/behavior.stderr" 2>/dev/null | tr '\n' ' ' | head -c 200)
    BEH_NOTE="exit $BEH_EXIT: $STDERR_TAIL"
    say "- [ ] exit $BEH_EXIT (see behavior.stderr)"
    [[ -n "$STDERR_TAIL" ]] && say "      stderr: $STDERR_TAIL"
  else
    BEH_STATUS="partial"
    BEH_NOTE="ambiguous — events=$EVT_COUNT_BH agent_start=$SAW_AGENT_START_BH"
    say "- [~] ambiguous (events=$EVT_COUNT_BH agent_start=$SAW_AGENT_START_BH)"
  fi
else
  say "- [ ] skipped (load failed)"
fi

# --- summary -----------------------------------------------------------------
HEADLINE=""
if [[ ${#EXT_FILES[@]} -eq 0 ]]; then
  HEADLINE="no artifacts"
elif [[ $P0_PASS -eq $P0_TOTAL && "$LOAD_STATUS" == "pass" && "$BEH_STATUS" == "pass" ]]; then
  HEADLINE="full pass"
elif [[ $P0_PASS -ge $((P0_TOTAL * 3 / 4)) ]]; then
  HEADLINE="mostly passing"
else
  HEADLINE="major misses"
fi

say
say "## Summary"
say "- P0: $P0_PASS/$P0_TOTAL"
say "- P1: $P1_PASS/$P1_TOTAL"
say "- Load: $LOAD_STATUS${LOAD_NOTE:+ ($LOAD_NOTE)}"
say "- Behavioral: $BEH_STATUS${BEH_NOTE:+ ($BEH_NOTE)}"
say "- Headline: $HEADLINE"

{
  printf '{'
  printf '"model": "%s",' "$MODEL"
  printf '"p0_passed": "%s/%s",' "$P0_PASS" "$P0_TOTAL"
  printf '"p1_passed": "%s/%s",' "$P1_PASS" "$P1_TOTAL"
  printf '"load": "%s",' "$LOAD_STATUS"
  printf '"behavioral": "%s",' "$BEH_STATUS"
  printf '"headline": "%s",' "$HEADLINE"
  printf '"notes": ['
  first=1
  for n in "${NOTES[@]}"; do
    if [[ $first -eq 0 ]]; then printf ','; fi
    first=0
    # JSON-escape minimally (quotes/backslashes)
    esc="${n//\\/\\\\}"; esc="${esc//\"/\\\"}"
    printf '"%s"' "$esc"
  done
  printf ']}'
} > "$JSON"
