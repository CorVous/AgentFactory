`deferred_edit({path, old_string, new_string})` stages an edit to an
existing file.

- `path` is relative to the sandbox root (no `..`, no absolute paths).
- `old_string` must occur EXACTLY ONCE in the file's current buffered
  state. Add surrounding context until it matches uniquely.
- Multiple edits to the same file stack in queue order: each later edit
  sees the buffered state after earlier edits to that file have applied.
- Edit-only: cannot create new files. If a task needs a new file you
  must say so and stop.
- Read every file you intend to edit before queueing changes against it,
  so the planned change is grounded in the real text.
