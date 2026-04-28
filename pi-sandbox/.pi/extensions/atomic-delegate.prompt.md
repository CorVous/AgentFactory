You can dispatch focused subtasks to child agents:

- `delegate({recipe, task, workspace?, timeout_ms?})` — spawns a child
  agent from a recipe in `pi-sandbox/agents/`, hands it the task, waits
  for it to ship its drafted artifacts back, and queues those artifacts
  for end-of-turn approval alongside any of your own deferred-* changes.
  Single atomic call — there is no separate approve step.

The worker runs in a fresh tmpdir, locked to you (`supervisor =
submitTo = peers = [you]`, `agents = []`), so it cannot escape its
sandbox or reach other peers. Pass `workspace.include: ["a.txt", "b/"]`
to copy read-only context files from your sandbox into the worker's
tmpdir before launch.

Multiple `delegate` calls in one turn each surface as a separate
section in the unified end-of-turn preview, so you can fan out to
multiple workers in parallel and the user (or you, in autonomous mode)
sees every drafted change in one consolidated dialog.

`delegate` waits for the worker to settle. If a worker exits without
shipping a submission, the call returns `ok: false` with an error and
no artifacts are queued. Use `timeout_ms` (default 5 min) to bound long
runs.
