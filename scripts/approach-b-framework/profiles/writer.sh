#!/usr/bin/env bash
# profiles/writer.sh — deferred-writer pattern (in-memory staging +
# approval gate + promote). Mirrors the rubric anchors in
# scripts/deferred-writer-rubric.md.
#
# Uses helpers from lib/harness.sh (mark_p0/mark_p1, grep_any, blob_has,
# extract_tools_allowlist) and lib/core-rails.sh. Must be sourced AFTER
# both of those.
#
# Profile contract hooks (grade-task.sh calls these in sequence):
#   profile_classify_stray <file>    → echo "ext" | "child" | "ignore"
#   profile_grade_structural         → P0 structural bullets
#   profile_grade_tools_allowlist    → P0 --tools bullet
#   profile_grade_harvest            → P0 harvest field bullet
#   profile_grade_side_effects       → P0 confirm + write bullets
#   profile_grade_polish             → P1 polish bullets
#   profile_behavioral_probe         → spawns a real pi, sets BEH_STATUS

# shellcheck shell=bash

profile_classify_stray() {
  local f="$1"
  if grep -q "registerCommand" "$f" 2>/dev/null; then
    echo "ext"
  elif grep -q "registerTool" "$f" 2>/dev/null && grep -q "stage_write\|stage-write" "$f" 2>/dev/null; then
    echo "child"
  else
    echo "ignore"
  fi
}

profile_grade_structural() {
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

  if [[ $LAYOUT_OK -eq 1 && (${#EXT_FILES[@]} -gt 0 || ${#CHILD_FILES[@]} -gt 0) ]]; then
    mark_p0 "files placed at canonical .pi/extensions + .pi/child-tools paths" pass
  elif [[ ${#EXT_FILES[@]} -gt 0 || ${#CHILD_FILES[@]} -gt 0 ]]; then
    mark_p0 "files placed at canonical .pi/extensions + .pi/child-tools paths" fail "files ended up in stray locations"
  else
    mark_p0 "files placed at canonical .pi/extensions + .pi/child-tools paths" fail "no files produced"
  fi

  # stage_write lives in the child-tool file. A monolithic extension that
  # inlines stage_write counts as a partial miss (content found but
  # layout wrong).
  if [[ ${#CHILD_FILES[@]} -gt 0 ]] && grep_any "stage_write" "${CHILD_FILES[@]}"; then
    mark_p0 "stage_write tool defined in child-tool file" pass
  elif [[ ${#ALL_FILES[@]} -gt 0 ]] && grep_any "stage_write" "${ALL_FILES[@]}"; then
    mark_p0 "stage_write tool defined in child-tool file" fail "found elsewhere, not in child-tools/"
  else
    mark_p0 "stage_write tool defined in child-tool file" fail "stage_write not found anywhere"
  fi
}

profile_grade_tools_allowlist() {
  local allow
  allow=$(extract_tools_allowlist)
  if [[ -z "$allow" ]]; then
    mark_p0 "--tools allowlist is stage_write (+ls) only, no read/write/bash/etc" fail "no --tools flag found"
    return
  fi
  if [[ ",$allow," != *",stage_write,"* ]]; then
    mark_p0 "--tools allowlist is stage_write (+ls) only, no read/write/bash/etc" fail "stage_write not in allowlist: $allow"
    return
  fi
  local forbidden
  for forbidden in write edit bash grep glob read; do
    if [[ ",$allow," == *",$forbidden,"* ]]; then
      mark_p0 "--tools allowlist is stage_write (+ls) only, no read/write/bash/etc" fail "got: $allow"
      return
    fi
  done
  mark_p0 "--tools allowlist is stage_write (+ls) only, no read/write/bash/etc" pass
}

profile_grade_harvest() {
  say "## Harvest + validate"
  # tool_execution_start is the event writer harvests from.
  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "tool_execution_start" "${EXT_FILES[@]}"; then
    mark_p0 "harvest source = tool_execution_start event" pass
  else
    mark_p0 "harvest source = tool_execution_start event" fail
  fi

  local ok=1
  if [[ -n "$EXT_BLOB" ]]; then
    if blob_has_ere '(e|event)\.args\.(path|content)|args\.(path|content)|= *(e|event)\.args|= *inputObj' \
       || blob_has "= event.args" || blob_has "= e.args"; then
      :
    else
      ok=0
    fi
    if blob_has "toolCall.input"; then
      ok=0
    fi
  else
    ok=0
  fi
  if [[ $ok == 1 ]]; then
    mark_p0 "harvest from e.args.path/content (not e.toolCall.input)" pass
  else
    mark_p0 "harvest from e.args.path/content (not e.toolCall.input)" fail
  fi
}

profile_grade_side_effects() {
  say "## Approval + promote"
  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "ctx.ui.confirm" "${EXT_FILES[@]}"; then
    mark_p0 "ctx.ui.confirm before disk write" pass
  else
    mark_p0 "ctx.ui.confirm before disk write" fail
  fi

  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "fs.writeFileSync(" "${EXT_FILES[@]}" && grep_any_ere 'fs\.mkdirSync\(.*recursive.*true' "${EXT_FILES[@]}"; then
    mark_p0 "fs.writeFileSync + mkdirSync recursive on promote" pass
  else
    mark_p0 "fs.writeFileSync + mkdirSync recursive on promote" fail
  fi
}

profile_grade_polish() {
  say "## P1 polish"
  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any_ere '\.slice\(0, *[0-9]+\)' "${EXT_FILES[@]}"; then
    mark_p1 "notify truncation" pass
  else
    mark_p1 "notify truncation" fail
  fi

  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "createHash(\"sha256\")" "${EXT_FILES[@]}"; then
    mark_p1 "sha256 post-write verify" pass
  elif [[ ${#EXT_FILES[@]} -gt 0 ]] \
       && [[ $(grep -cH "fs.existsSync" "${EXT_FILES[@]}" 2>/dev/null | awk -F: '{s+=$NF} END{print s+0}') -ge 2 ]]; then
    mark_p1 "sha256 post-write verify" pass "substituted by double existsSync check"
  else
    mark_p1 "sha256 post-write verify" fail
  fi

  if blob_has_ere '[`"'\'']--thinking[`"'\''][^a-zA-Z]+[`"'\'']off[`"'\'']|--thinking off' && blob_has "--no-session"; then
    mark_p1 "--thinking off + --no-session on drafter" pass
  else
    mark_p1 "--thinking off + --no-session on drafter" fail
  fi

  local notify_count=0
  if [[ ${#EXT_FILES[@]} -gt 0 ]]; then
    notify_count=$(grep -cHE 'ctx\.ui\.notify\(' "${EXT_FILES[@]}" 2>/dev/null | awk -F: '{s+=$NF} END{print s+0}')
  fi
  if [[ $notify_count -ge 4 ]]; then
    mark_p1 "notifies at phase boundaries (>=4 calls)" pass "$notify_count calls"
  else
    mark_p1 "notifies at phase boundaries (>=4 calls)" fail "$notify_count calls"
  fi
}

# profile_behavioral_probe — inject the snapshot's artifacts back into
# the real sandbox, run the writer's slash command with a create-file
# task, assert that it dispatches + cancels cleanly (exit 0, no
# `agent_start` events on the outer stream because the slash command is
# registered and the child's NDJSON flows into the parser, not stdout).
#
# In print mode `ctx.ui.confirm` returns false unconditionally, so the
# correct handler treats that as cancel and exits 0. Timeout (124) or
# nonzero exit means the extension hangs or throws — both fail.
#
# Uses: $LOG, $SANDBOX, $REPO, $CMD_NAME, $TASK_MODEL, $PROBE_ARGS,
# $LOAD_STATUS. Writes: $BEH_STATUS / $BEH_NOTE.
profile_behavioral_probe() {
  say "## Behavioral smoke"
  BEH_STATUS="skip"
  BEH_NOTE=""

  if [[ "${SKIP_BEH:-0}" == "1" ]]; then
    BEH_STATUS="skip"; BEH_NOTE="SKIP_BEH=1"
    say "- [-] skipped (SKIP_BEH=1)"
    return
  fi

  if [[ "$LOAD_STATUS" != "pass" && "$LOAD_STATUS" != "partial" ]]; then
    say "- [ ] skipped (load failed)"
    return
  fi

  # Extensions + child-tools are already at $LOG/.pi/{extensions,child-tools}/
  # from the agent-maker generation phase; the probe runs from $LOG so pi
  # auto-discovers them there. Keeps the probe parallel-safe and leaves
  # the shared $SANDBOX untouched.

  set +e
  (
    cd "$LOG"
    timeout 180s env PI_SKIP_UPDATE_CHECK=1 \
      PATH="$REPO/node_modules/.bin:$PATH" \
      "$REPO/node_modules/.bin/pi" \
        --no-context-files --no-session --no-skills \
        --provider openrouter --model "$TASK_MODEL" \
        --mode json \
        -p "/$CMD_NAME${PROBE_ARGS:-}" \
        > "$LOG/behavior.ndjson" 2> "$LOG/behavior.stderr"
  )
  local BEH_EXIT=$?
  set -e

  # Defensive — handler SHOULD hit the cancel path and never write.
  # If it did write, the file would land in the probe cwd ($LOG).
  rm -f "$LOG/hello-probe.md" 2>/dev/null || true

  local EVT_COUNT_BH=0 SAW_AGENT_START_BH=0
  if [[ -f "$LOG/behavior.ndjson" ]]; then
    EVT_COUNT_BH=$(wc -l < "$LOG/behavior.ndjson" 2>/dev/null | awk '{print $1+0}')
    SAW_AGENT_START_BH=$(grep -c '"type":"agent_start"' "$LOG/behavior.ndjson" 2>/dev/null; true)
    SAW_AGENT_START_BH="${SAW_AGENT_START_BH:-0}"
  fi

  if [[ $BEH_EXIT -eq 0 && $SAW_AGENT_START_BH -eq 0 && ${EVT_COUNT_BH:-0} -le 3 ]]; then
    BEH_STATUS="pass"
    say "- [x] exit 0; handler ran, dispatched + cancelled cleanly"
  elif [[ $BEH_EXIT -eq 0 && $SAW_AGENT_START_BH -ge 1 ]]; then
    BEH_STATUS="fail"; BEH_NOTE="command not registered — /cmd went to LLM instead of handler"
    say "- [ ] command not registered (went to LLM)"
  elif [[ $BEH_EXIT -eq 124 ]]; then
    BEH_STATUS="fail"; BEH_NOTE="timed out after 180s (hang)"
    say "- [ ] timed out — hang"
  elif [[ $BEH_EXIT -ne 0 ]]; then
    BEH_STATUS="fail"
    local tail_out
    tail_out=$(tail -3 "$LOG/behavior.stderr" 2>/dev/null | tr '\n' ' ' | head -c 200)
    BEH_NOTE="exit $BEH_EXIT: $tail_out"
    say "- [ ] exit $BEH_EXIT (see behavior.stderr)"
    [[ -n "$tail_out" ]] && say "      stderr: $tail_out"
  else
    BEH_STATUS="partial"; BEH_NOTE="ambiguous — events=$EVT_COUNT_BH agent_start=$SAW_AGENT_START_BH"
    say "- [~] ambiguous (events=$EVT_COUNT_BH agent_start=$SAW_AGENT_START_BH)"
  fi
}

# profile_grade — dispatch entrypoint. grade-task.sh calls this once
# after harness state is populated + core-rails checks have run.
profile_grade() {
  profile_grade_structural
  core_grade_registration
  core_grade_register_tool_shape
  core_grade_subprocess_rails
  profile_grade_tools_allowlist
  core_grade_ndjson_parsing
  profile_grade_harvest
  core_check_path_validation
  profile_grade_side_effects
  profile_grade_polish
  core_negative_anchors
  core_load_smoke
  profile_behavioral_probe
}
