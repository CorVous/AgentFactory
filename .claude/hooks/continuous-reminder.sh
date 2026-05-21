#!/usr/bin/env sh
# UserPromptSubmit hook for the /continuous skill.
# No-op unless a continuity session is active (marker file present).
git_dir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
marker="$git_dir/continuous-active"
[ -f "$marker" ] || exit 0
token="$(cat "$marker")"
doc="../html-previews-wt/continuous/$token.html"
echo "[continuous] Continuity session $token is active. As you work this turn, capture any new task progress, decisions, discovered information, plan changes/dead ends, or user-provided nuance into $doc: rewrite the snapshot section, append to the Decisions & nuance log. Then commit and push the html-previews branch. Read that file first if unsure of its current content."
exit 0
