#!/usr/bin/env bash
# profiles/recon.sh — read-only recon pattern (directory survey → bounded
# summary, no side effects). The read-only counterpart of writer.sh.
#
# Key shape differences from writer:
#   - One file (extension only); no child-tool, nothing to stage.
#   - --tools allowlist is read-only (ls + grep + glob + read); stage_write
#     / write / edit / bash are all FORBIDDEN.
#   - Summary is harvested from the child's message_end events (not
#     tool_execution_start), because read-only children produce text, not
#     staged tool calls.
#   - Absence anchors: no ctx.ui.confirm (no gate to open — there is no
#     side effect), no fs.writeFileSync outside .pi/scratch/ (recon does
#     not promote).
#   - Bounded-summary requirement: .slice(0, N) OR Buffer.byteLength
#     check on the harvested content.
#   - Behavioral probe: /<cmd> <fixture> on a stable pi-sandbox
#     subdirectory; verifies exit 0 + that SOMETHING identifying the
#     fixture surfaced under .pi/scratch/.

# shellcheck shell=bash

# Recon has no child-tool. Any stray that looks like an extension is
# promoted; everything else is ignored (we don't expect child-tools here
# — if one shows up, that's a skill-inference miss surfaced by the
# tool-allowlist check).
profile_classify_stray() {
  local f="$1"
  if grep -q "registerCommand" "$f" 2>/dev/null; then
    echo "ext"
  else
    echo "ignore"
  fi
}

profile_grade_structural() {
  say "## Structural"
  if [[ ${#EXT_FILES[@]} -ge 1 ]]; then
    mark_p0 "Extension file produced" pass
  else
    mark_p0 "Extension file produced" fail "no .ts output"
  fi

  if [[ $LAYOUT_OK -eq 1 && ${#EXT_FILES[@]} -gt 0 ]]; then
    mark_p0 "files placed at canonical .pi/extensions path" pass
  elif [[ ${#EXT_FILES[@]} -gt 0 ]]; then
    mark_p0 "files placed at canonical .pi/extensions path" fail "extension found outside .pi/extensions"
  else
    mark_p0 "files placed at canonical .pi/extensions path" fail "no files produced"
  fi

  # A child-tool here is a smell — recon has no staging channel. Log it,
  # don't fail a rubric point (the allowlist check catches the real
  # defect: something was wired as a tool that shouldn't have been).
  if [[ ${#CHILD_FILES[@]} -gt 0 ]]; then
    NOTES+=("warn: recon profile produced ${#CHILD_FILES[@]} child-tool file(s) (unexpected for read-only shape)")
    say "- [!] unexpected child-tool file(s) for recon shape: ${#CHILD_FILES[@]}"
  fi
}

profile_grade_tools_allowlist() {
  local allow
  allow=$(extract_tools_allowlist)
  if [[ -z "$allow" ]]; then
    mark_p0 "--tools allowlist is read-only (ls/grep/glob/read), no writers" fail "no --tools flag found"
    return
  fi
  # At least one read-only verb MUST be present. `ls` alone is valid for
  # the narrowest case, but a useful recon will have read too. We accept
  # any of the four — the reading-short-prompts.md table lists all four
  # as canonical for "read-only / survey / recon / explore".
  local has_read_verb=0 forbidden=""
  local v
  for v in ls read grep glob; do
    if [[ ",$allow," == *",$v,"* ]]; then has_read_verb=1; fi
  done
  for v in stage_write write edit bash; do
    if [[ ",$allow," == *",$v,"* ]]; then forbidden="$forbidden $v"; fi
  done
  if [[ $has_read_verb -eq 0 ]]; then
    mark_p0 "--tools allowlist is read-only (ls/grep/glob/read), no writers" fail "no read-only verb present: $allow"
  elif [[ -n "$forbidden" ]]; then
    mark_p0 "--tools allowlist is read-only (ls/grep/glob/read), no writers" fail "forbidden verb(s):$forbidden in $allow"
  else
    mark_p0 "--tools allowlist is read-only (ls/grep/glob/read), no writers" pass
  fi
}

profile_grade_harvest() {
  say "## Harvest + validate"
  # Recon reads the CHILD's final answer, which arrives as message_end
  # (assistant role) — not as a tool call. message_update is acceptable
  # too for streaming-collection implementations.
  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any_ere 'message_end|message_update' "${EXT_FILES[@]}"; then
    mark_p0 "harvest source = message_end / message_update event" pass
  else
    mark_p0 "harvest source = message_end / message_update event" fail
  fi

  # Negative: recon MUST NOT handle tool_execution_start AND read args
  # off it — that's the writer harvest pattern. Accept any of the
  # common shapes the writer uses: direct e.args.path/content,
  # destructured `= e.args` / `= event.args`, or the `inputObj = e.args`
  # idiom that the reference implementation uses.
  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "tool_execution_start" "${EXT_FILES[@]}" \
     && grep_any_ere '(e|event)\.args\.(path|content)|args\.(path|content)|= *(e|event)\.args|= *inputObj|inputObj\.(path|content)' "${EXT_FILES[@]}"; then
    mark_p0 "no writer-shape harvest (tool_execution_start + args)" fail "found writer-shape harvest in a recon agent"
  else
    mark_p0 "no writer-shape harvest (tool_execution_start + args)" pass
  fi
}

# Recon has no side effects to approve; absence of the writer's gate
# IS the rubric point. Presence of ctx.ui.confirm means the model
# copied writer boilerplate without reading the prompt.
profile_grade_side_effects() {
  say "## No side-effect (absence checks)"
  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any "ctx.ui.confirm" "${EXT_FILES[@]}"; then
    mark_p0 "no ctx.ui.confirm (recon has nothing to gate)" fail "found ctx.ui.confirm in a read-only agent"
  else
    mark_p0 "no ctx.ui.confirm (recon has nothing to gate)" pass
  fi

  # If the extension writes files, the destination path must be scoped
  # to .pi/scratch/. We can't statically resolve variable destinations
  # (the writer may compute dest = path.resolve(scratchDir, ...) on a
  # separate line), so the code-level check is lenient: ANY mention
  # of "scratch" anywhere in the extension passes. The behavioral
  # probe catches the actual "wrote outside scratch" defect at runtime
  # by scanning $SANDBOX for stray evidence files — see
  # profile_behavioral_probe. Two nets; one forgiving, one strict.
  if [[ ${#EXT_FILES[@]} -eq 0 ]] || ! grep_any "fs.writeFileSync(" "${EXT_FILES[@]}"; then
    mark_p0 "no fs.writeFileSync outside .pi/scratch/" pass "no fs.writeFileSync calls"
  elif grep_any "scratch" "${EXT_FILES[@]}"; then
    mark_p0 "no fs.writeFileSync outside .pi/scratch/" pass
  else
    mark_p0 "no fs.writeFileSync outside .pi/scratch/" fail "writeFileSync present but no 'scratch' anchor anywhere"
  fi
}

profile_grade_polish() {
  say "## P1 polish"
  # Bounded-summary anchor: either a .slice(0, N) on the harvested
  # content OR a Buffer.byteLength check. Either proves the model
  # thought about size before notifying.
  if [[ ${#EXT_FILES[@]} -gt 0 ]] \
     && { grep_any_ere '\.slice\(0, *[0-9]+\)' "${EXT_FILES[@]}" \
          || grep_any_ere 'Buffer\.byteLength\(' "${EXT_FILES[@]}"; }; then
    mark_p0 "summary bounded (.slice(0, N) or Buffer.byteLength)" pass
  else
    mark_p0 "summary bounded (.slice(0, N) or Buffer.byteLength)" fail
  fi

  if blob_has_ere '[`"'\'']--thinking[`"'\''][^a-zA-Z]+[`"'\'']off[`"'\'']|--thinking off' && blob_has "--no-session"; then
    mark_p1 "--thinking off + --no-session on recon child" pass
  else
    mark_p1 "--thinking off + --no-session on recon child" fail
  fi

  local notify_count=0
  if [[ ${#EXT_FILES[@]} -gt 0 ]]; then
    notify_count=$(grep -cH "ctx.ui.notify" "${EXT_FILES[@]}" 2>/dev/null | awk -F: '{s+=$NF} END{print s+0}')
  fi
  # Recon typically notifies 2–3 times (entry, child-progress, final
  # summary). ≥2 is a reasonable bar; writer's ≥4 would over-score
  # a profile with fewer phase boundaries.
  if [[ $notify_count -ge 2 ]]; then
    mark_p1 "notifies at phase boundaries (>=2 calls)" pass "$notify_count calls"
  else
    mark_p1 "notifies at phase boundaries (>=2 calls)" fail "$notify_count calls"
  fi
}

# profile_behavioral_probe — run /<cmd> against a stable fixture
# subdirectory (set via PROBE_ARGS in task.env), assert exit 0, and
# hunt for evidence that the recon actually ran. Evidence = a file
# newer than the probe-start marker under $SANDBOX/.pi/scratch/
# containing $PROBE_EVIDENCE_ANCHOR (a known filename from the
# fixture — e.g. SKILL.md). In print mode `ctx.ui.notify` is a no-op,
# so notify content is invisible; the only visible channel for a
# summary is a scratch file the parent writes after harvesting from
# the child. Behaviorally this also confirms anchor #4 (no write
# outside scratch) — if evidence lands elsewhere, we record the
# stray location as a failure.
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

  rm -rf "$SANDBOX/.pi/extensions"/* "$SANDBOX/.pi/child-tools"/* 2>/dev/null || true
  cp -a "$ART/extensions/." "$SANDBOX/.pi/extensions/" 2>/dev/null || true

  # Marker used to find files the probe may have created.
  touch "$LOG/.beh-start"

  set +e
  (
    cd "$SANDBOX"
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

  # Hunt for evidence. Two probes in order of strictness:
  #   (a) any file under .pi/scratch/ newer than .beh-start containing
  #       PROBE_EVIDENCE_ANCHOR — pass (recon ran AND wrote to the
  #       allowed sink).
  #   (b) any file ANYWHERE under $SANDBOX newer than .beh-start
  #       containing PROBE_EVIDENCE_ANCHOR — fail; anchor landed but
  #       the model wrote outside .pi/scratch/.
  local anchor="${PROBE_EVIDENCE_ANCHOR:-SKILL.md}"
  local scratch_hit="" stray_hit=""
  if [[ -d "$SANDBOX/.pi/scratch" ]]; then
    scratch_hit=$(find "$SANDBOX/.pi/scratch" -newer "$LOG/.beh-start" -type f \
      \( -name '*.md' -o -name '*.txt' \) \
      -exec grep -l -- "$anchor" {} \; 2>/dev/null | head -1 || true)
  fi
  stray_hit=$(find "$SANDBOX" -newer "$LOG/.beh-start" -type f \
    -not -path "*/.pi/scratch/*" \
    -not -path "*/.pi/extensions/*" \
    -not -path "*/.pi/child-tools/*" \
    -not -path "*/node_modules/*" \
    \( -name '*.md' -o -name '*.txt' \) \
    -exec grep -l -- "$anchor" {} \; 2>/dev/null | head -1 || true)

  # Snapshot any scratch artifact the probe produced so it's inspectable
  # later from the log dir.
  if [[ -n "$scratch_hit" ]]; then
    mkdir -p "$LOG/behavior-artifacts"
    cp -a "$scratch_hit" "$LOG/behavior-artifacts/" 2>/dev/null || true
  fi

  # Reset the sandbox even if the probe wrote to scratch — leave other
  # runs a clean slate.
  rm -rf "$SANDBOX/.pi/extensions"/* 2>/dev/null || true
  if [[ -n "$stray_hit" ]]; then
    rm -f "$stray_hit" 2>/dev/null || true
  fi

  local EVT_COUNT_BH=0 SAW_AGENT_START_BH=0
  if [[ -f "$LOG/behavior.ndjson" ]]; then
    EVT_COUNT_BH=$(wc -l < "$LOG/behavior.ndjson" 2>/dev/null | awk '{print $1+0}')
    SAW_AGENT_START_BH=$(grep -c '"type":"agent_start"' "$LOG/behavior.ndjson" 2>/dev/null; true)
    SAW_AGENT_START_BH="${SAW_AGENT_START_BH:-0}"
  fi

  if [[ $BEH_EXIT -eq 124 ]]; then
    BEH_STATUS="fail"; BEH_NOTE="timed out after 180s (hang)"
    say "- [ ] timed out — hang"
  elif [[ $BEH_EXIT -ne 0 ]]; then
    BEH_STATUS="fail"
    local tail_out
    tail_out=$(tail -3 "$LOG/behavior.stderr" 2>/dev/null | tr '\n' ' ' | head -c 200)
    BEH_NOTE="exit $BEH_EXIT: $tail_out"
    say "- [ ] exit $BEH_EXIT (see behavior.stderr)"
    [[ -n "$tail_out" ]] && say "      stderr: $tail_out"
  elif [[ $SAW_AGENT_START_BH -ge 1 ]]; then
    BEH_STATUS="fail"; BEH_NOTE="command not registered — /cmd went to LLM instead of handler"
    say "- [ ] command not registered (went to LLM)"
  elif [[ -n "$stray_hit" && -z "$scratch_hit" ]]; then
    BEH_STATUS="fail"; BEH_NOTE="summary landed outside .pi/scratch/: ${stray_hit#$SANDBOX/}"
    say "- [ ] summary written outside scratch dir: ${stray_hit#$SANDBOX/}"
  elif [[ -n "$scratch_hit" ]]; then
    BEH_STATUS="pass"
    say "- [x] exit 0; summary with '$anchor' landed under .pi/scratch/: ${scratch_hit#$SANDBOX/}"
  elif [[ $BEH_EXIT -eq 0 ]]; then
    # Clean exit but no file evidence — in print mode notify is a
    # no-op, so a correct extension that only notifies would look
    # identical to a silent no-op. Score this as partial.
    BEH_STATUS="partial"
    BEH_NOTE="exit 0 but no scratch file containing '$anchor' — may have notified only (invisible in print mode)"
    say "- [~] exit 0; no scratch evidence of summary (notify is no-op in print mode)"
  else
    BEH_STATUS="partial"; BEH_NOTE="ambiguous — exit=$BEH_EXIT events=$EVT_COUNT_BH"
    say "- [~] ambiguous (exit=$BEH_EXIT events=$EVT_COUNT_BH)"
  fi
}

# profile_grade — dispatch entrypoint. Ordering matches writer.sh for
# easy diff. Recon skips core_grade_register_tool_shape (no tools
# expected) and core_check_path_validation (no multi-path writes).
profile_grade() {
  profile_grade_structural
  core_grade_registration
  core_grade_subprocess_rails
  profile_grade_tools_allowlist
  core_grade_ndjson_parsing
  profile_grade_harvest
  profile_grade_side_effects
  profile_grade_polish
  core_negative_anchors
  core_load_smoke
  profile_behavioral_probe
}
