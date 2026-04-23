#!/usr/bin/env bash
# lib/core-rails.sh — always-on rubric anchors, profile-independent.
#
# These are the rails from pi-sandbox/skills/pi-agent-builder/references/
# defaults.md that apply to EVERY sub-agent-spawning extension the skill
# generates, regardless of whether the profile is writer, recon, or
# orchestrator. Each function writes rubric bullets via mark_p0/mark_p1
# from lib/harness.sh and MUST be called with harness state populated
# (EXT_FILES, ALL_FILES, EXT_BLOB, etc.).
#
# Functions here never `return` an error code — scoring outcomes flow
# through the mark_p0/mark_p1 counters. The only exception is the load
# probe, which sets $LOAD_STATUS / $LOAD_NOTE for the final summary.

# shellcheck shell=bash

# core_grade_registration — P0: exactly one registerCommand in the
# extension (the entry point for the slash command). Also extracts
# $CMD_NAME for later probes.
core_grade_registration() {
  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any_ere "pi\.registerCommand\(['\"]" "${EXT_FILES[@]}"; then
    mark_p0 "registerCommand in extension" pass
  else
    mark_p0 "registerCommand in extension" fail
  fi

  CMD_NAME=$(extract_cmd_name)
  if [[ -n "$CMD_NAME" ]]; then
    say "- registered slash command: \`/$CMD_NAME\`"
  else
    say "- [warn] could not extract registered slash command name"
  fi
}

# core_grade_register_tool_shape — P0: every registerTool call returns
# `{content, details}`. `details` is mandatory for TS compile even on
# stubs (AGENTS.md gotcha #2). Only applies when any tool is registered;
# profiles that don't register tools skip this via a `[[ $PROFILE_HAS_TOOL
# != 1 ]] && return`-style guard at their call site.
core_grade_register_tool_shape() {
  if [[ ${#ALL_FILES[@]} -gt 0 ]] && grep_any_ere "registerTool\(" "${ALL_FILES[@]}" && grep_any "details" "${ALL_FILES[@]}"; then
    mark_p0 "registerTool returns {content, details}" pass
  else
    mark_p0 "registerTool returns {content, details}" fail
  fi
}

# core_grade_subprocess_rails — the subprocess-spawning rails from
# defaults.md -> "For every sub-agent". Every rail here is mandatory
# regardless of what the child does; the profile's allowlist check
# (which tools the child gets) is separate.
core_grade_subprocess_rails() {
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
}

# core_grade_ndjson_parsing — P0: parent parses the child's NDJSON stream
# line-by-line. Applies to any profile that spawns a `--mode json` child
# (writer + recon + orchestrator all do).
core_grade_ndjson_parsing() {
  if [[ ${#EXT_FILES[@]} -gt 0 ]] \
     && grep_any_ere 'tool_execution_start|message_end|message_update' "${EXT_FILES[@]}" \
     && grep_any "JSON.parse(" "${EXT_FILES[@]}"; then
    mark_p0 "NDJSON parsed line-by-line from child stdout" pass
  else
    mark_p0 "NDJSON parsed line-by-line from child stdout" fail
  fi
}

# core_check_path_validation — P0 helper for profiles that write files.
# Callers that don't write (pure recon) skip invoking this.
core_check_path_validation() {
  if [[ ${#EXT_FILES[@]} -gt 0 ]] \
     && grep_any_ere 'path\.isAbsolute|isAbsolute\(' "${EXT_FILES[@]}" \
     && grep_any "fs.existsSync" "${EXT_FILES[@]}" \
     && grep_any_ere '\.\."|"\.\.' "${EXT_FILES[@]}"; then
    mark_p0 "path validation (absolute / .. / exists)" pass
  else
    mark_p0 "path validation (absolute / .. / exists)" fail
  fi

  if [[ ${#EXT_FILES[@]} -gt 0 ]] && grep_any_ere 'startsWith\(sandboxRoot|startsWith\([a-zA-Z_]+ \+ path\.sep\)' "${EXT_FILES[@]}"; then
    mark_p0 "sandbox-root escape check (startsWith)" pass
  else
    mark_p0 "sandbox-root escape check (startsWith)" fail
  fi
}

# core_negative_anchors — warnings (not P0/P1) for anti-patterns listed
# in defaults.md. Only console.log for now; profiles can layer their own
# negatives on top.
core_negative_anchors() {
  say "## Negative anchors"
  if [[ ${#ALL_FILES[@]} -gt 0 ]] && grep_any "console.log" "${ALL_FILES[@]}"; then
    NOTES+=("warn: console.log present (TUI anti-pattern)")
    say "- [!] console.log present (anti-pattern)"
  fi
}

# core_load_smoke — universal: does the extension load and register its
# slash command? Probe runs `pi -p /<CMD_NAME>` with no args under
# --no-tools. A registered command short-circuits in
# _tryExecuteExtensionCommand and emits only the session header; an
# unregistered one falls through to the LLM and emits a full turn
# cascade. Handler errors still count as "registered" because the
# session header fires before the handler runs.
#
# Inputs:  $REPO, $LOG, $CMD_NAME, $TASK_MODEL (optional)
# Outputs: $LOAD_STATUS ∈ {pass, partial, fail, skip}
#          $LOAD_NOTE   short human-readable reason
core_load_smoke() {
  say "## Load smoke"
  LOAD_STATUS="skip"
  LOAD_NOTE=""

  if [[ "${SKIP_LOAD:-0}" == "1" ]]; then
    LOAD_STATUS="skip"
    LOAD_NOTE="SKIP_LOAD=1"
    say "- [-] skipped (SKIP_LOAD=1)"
    return
  fi

  if [[ ${#EXT_FILES[@]} -eq 0 ]]; then
    LOAD_STATUS="skip"
    say "- [ ] skipped (no extension file)"
    return
  fi

  if [[ -z "$CMD_NAME" ]]; then
    LOAD_STATUS="fail"
    LOAD_NOTE="could not extract registered command name from extension"
    say "- [ ] skipped (no CMD_NAME found in extension)"
    return
  fi

  local EXT_FILE="${EXT_FILES[0]}"
  local TASK_MODEL_FOR_LOAD="${TASK_MODEL:-anthropic/claude-haiku-4.5}"

  set +e
  timeout 30s env PI_SKIP_UPDATE_CHECK=1 TASK_MODEL="$TASK_MODEL_FOR_LOAD" \
    PATH="$REPO/node_modules/.bin:$PATH" \
    "$REPO/node_modules/.bin/pi" \
      --no-context-files --no-session --no-skills --no-extensions \
      -e "$EXT_FILE" \
      --mode json --no-tools \
      --provider openrouter --model "$TASK_MODEL_FOR_LOAD" \
      -p "/$CMD_NAME" \
      > "$LOG/load.ndjson" 2> "$LOG/load.stderr"
  local LOAD_EXIT=$?
  set -e

  local EVT_COUNT SAW_AGENT_START STDERR_TAIL
  EVT_COUNT=$(wc -l < "$LOG/load.ndjson" 2>/dev/null | awk '{print $1+0}')
  SAW_AGENT_START=$(grep -c '"type":"agent_start"' "$LOG/load.ndjson" 2>/dev/null; true)
  SAW_AGENT_START="${SAW_AGENT_START:-0}"

  if [[ $LOAD_EXIT -eq 0 && $SAW_AGENT_START -eq 0 && ${EVT_COUNT:-0} -ge 1 && ${EVT_COUNT:-0} -le 3 ]]; then
    LOAD_STATUS="pass"
    say "- [x] command /$CMD_NAME registered (no LLM call)"
  elif [[ $LOAD_EXIT -ne 0 && $SAW_AGENT_START -eq 0 && ${EVT_COUNT:-0} -ge 1 && ${EVT_COUNT:-0} -le 3 ]]; then
    LOAD_STATUS="partial"
    LOAD_NOTE="command registered but handler didn't short-circuit on empty args (exit $LOAD_EXIT)"
    say "- [~] command /$CMD_NAME registered, but handler ran heavy work on empty args (exit $LOAD_EXIT)"
  elif [[ ${EVT_COUNT:-0} -eq 0 ]]; then
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
}
