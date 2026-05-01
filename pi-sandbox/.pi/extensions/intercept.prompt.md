## Intercept rail — human-in-the-loop decisions

When the operator is focused on this peer in the launcher TUI, inbound
`submission` and `approval-request` envelopes are routed to the human via
an interactive dialog **instead of reaching `respond_to_request`**.

This means:

- You will **not** see `respond_to_request` prompts for envelopes that the
  human intercepted. The human's pick (approve, reject, revise, escalate)
  generates the appropriate bus reply directly.
- If the human shifts focus away while the dialog is open, the dialog is
  cancelled and the envelope prompt is re-injected to you as a fresh
  `respond_to_request` turn — you may then use the tool normally.
- When the operator is **not** focused on this peer, all envelopes reach
  you via the normal `respond_to_request` flow with no change.
- `message`-kind envelopes are never intercepted; they always arrive via
  the normal chat/inbox path.
