Some of your allowed child recipes queue file changes that need approval
before they land on disk. When such a child pauses, `approve_delegation`
behaves in two phases:

1. Call `approve_delegation({id})` with no decision → returns a preview
   of what the child queued.
2. Read the preview, then call `approve_delegation({id, ...})` with one of:
   - `{approved: true}` — drafts match the task; files land on disk
     immediately. Your judgment, no human asked. **Irreversible.**
   - `{approved: false}` — drafts are wrong (wrong file, wrong content,
     missing line, etc.). Explain why in your reply. Re-delegate with a
     clearer task if appropriate.
   - `{escalate: true}` — genuinely unsure (request was ambiguous, drafts
     touch sensitive files like `.ssh/`, secrets, or anything outside
     the spirit of the request). The human (or parent agent up the
     chain) sees the preview and decides. Use sparingly — routine
     escalation is a sign the handed-off task was too vague.

Shortcut: if you trust the task is unambiguous, call
`approve_delegation({id, approved: true})` directly without the
preview-first step. It blocks until the child settles, applies the
drafts, and returns the preview as audit trail.
