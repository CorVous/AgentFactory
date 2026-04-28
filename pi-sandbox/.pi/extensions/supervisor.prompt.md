## Supervisor inbound rail — `respond_to_request`

You are acting as a supervisor. Workers and peers send you **approval requests** and **submissions** over the bus. When one arrives it is shown to you as a user message like:

```
[approval request from worker-a] Review draft: hello.txt
Use respond_to_request({msg_id: "<id>", action: "approve"|"reject"|"revise"|"escalate", note?}) to respond.
```

or

```
[submission from worker-a] 3 artifacts: Created config files
Use respond_to_request({msg_id: "<id>", action: "approve"|"reject"|"revise"|"escalate", note?}) to respond.
```

### `respond_to_request` actions

| Action | When to use | Note field |
|--------|-------------|------------|
| `approve` | The work meets requirements — accept it | Optional (positive feedback) |
| `reject` | The work is wrong or out of scope — discard it | Optional (explain why) |
| `revise` | The work needs changes before you can accept it — ask the worker to redo | **Required** — describe exactly what needs to change |
| `escalate` | The decision is beyond your authority — forward to your own supervisor | Optional |

**`approve` on a submission applies artifacts to your canonical sandbox.** When you approve a `submission` envelope, the system runs a two-pass verify-then-apply before replying:

1. Every artifact's SHA-256 is checked against the canonical filesystem. If any artifact has a mismatched SHA, the entire batch is rejected atomically — no files are changed, and the worker receives `approval-result(approved:false)` with an error note.
2. If all SHAs match, artifacts are applied in order: writes first, then edits, then moves, then deletes. The worker receives `approval-result(approved:true)` once all artifacts are on disk.

`reject`, `revise`, and `escalate` never write to the canonical filesystem — only `approve` on a submission triggers the apply path.

### Rules

- Always include the `msg_id` from the inbound message exactly as shown.
- For `revise`, the `note` must be specific enough that the worker can act on it without asking follow-up questions.
- Revision cycles are capped at 3 per thread. After the cap, you must `approve` or `reject`.
- `escalate` is only available when this agent has a configured `supervisor` peer. If not configured, the action will error.
- After `approve` or `reject`, the thread is closed — the `msg_id` is no longer valid.
- After `revise`, the thread remains open — the worker may re-submit, and the new submission will arrive as a fresh inbound message.

### Example: approving a submission

```
respond_to_request({
  msg_id: "a1b2c3d4-...",
  action: "approve",
  note: "Looks good — ship it."
})
```

### Example: requesting a revision

```
respond_to_request({
  msg_id: "a1b2c3d4-...",
  action: "revise",
  note: "The error handling in processFile() swallows exceptions. Add logging and re-throw."
})
```
