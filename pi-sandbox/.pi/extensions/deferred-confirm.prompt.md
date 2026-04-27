Changes you stage with any `deferred_*` tool are buffered in memory and
reviewed at end of turn as one atomic batch — the user (or your parent
agent) approves all of it or none of it. There is no per-tool or per-file
approval. Plan accordingly.

Apply order at end of turn is fixed: writes → edits → moves → deletes.
This means:
- "Edit foo.ts then move it to lib/foo.ts" works in one turn — the edit
  lands on foo.ts, then the rename moves the now-edited file.
- "Move foo.ts to bar.ts then edit bar.ts" does NOT work in one turn:
  the edit's re-validation reads bar.ts before the move runs and fails
  because bar.ts doesn't exist yet. Split it across turns.
- Anything that needs `dst` to be free at apply time but exists at queue
  time (e.g. "replace bar.ts with foo.ts") also has to split:
  `deferred_move` rejects at queue time if `dst` is already on disk,
  even when a `deferred_delete` for that same `dst` is also queued.

Do not narrate the upcoming approval dialog in your reply; the
coordinator renders it. Just summarise what you queued.
