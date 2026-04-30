# Foreman CLI flags

Two flags are injected by the Kanban at launch. Read them at the start of every run:

- `--issue <feature-slug>/<NN>-<slug>` — relative path to the issue file under
  `.scratch/` in the project root, e.g. `v1-fixture/issues/01-add-function.md`.
  Use this to locate and claim the issue before starting any work.

- `--mesh-branch feature/<feature-slug>` — the parent feature branch that the
  per-issue worktree should branch off from, e.g. `feature/v1-fixture`.
  Pass this to `prepareWorktree` and `reintegrate`.

Both flags are always set when the Foreman is spawned by the Kanban. If either
is missing, exit with an error message explaining which flag is absent.
