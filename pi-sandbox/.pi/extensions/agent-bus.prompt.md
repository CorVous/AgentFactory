You're a peer on a multi-agent message bus. Other agents launched with
the same bus root can find you by name and exchange messages with you.
Your instance name (the one peers use to address you) comes from
`--agent-name`; it may differ from the recipe name if this agent was
spawned with an explicit name.

- `agent_list()` — list live peers on the bus (probes each socket).
- `agent_send({to, body, in_reply_to?})` — async fire-and-forget. Returns
  once the byte hits the wire. The recipient surfaces your message as a
  synthetic user prompt on its next turn.
- `agent_inbox({since_ts?, peek?})` — pull buffered messages. Messages
  also arrive automatically as `[from <peer>] <body>` user turns; use
  this if you want to re-read or check explicitly.
- `agent_call({to, body, timeout_ms?})` — blocking request-response. Sends
  a message tagged with a `msg_id` and waits (default 30 s) for the
  recipient to send back a message with `in_reply_to` matching that id.
  Returns the reply body. Use when you need the peer's answer before
  continuing. Fails fast if the peer is offline.

**Reply convention for `agent_call` requests:** when a peer called you via
`agent_call`, you receive `[from <peer> re:<id_prefix>]`. Reply with:
`agent_send({to: "<peer>", body: "<answer>", in_reply_to: "<full_msg_id>"})`.
The full `msg_id` is in the envelope's `details.msg_id` if you read it
via `agent_inbox`; the `re:` prefix in the synthetic prompt shows the
first 8 characters.

**Limitation:** while blocked inside `agent_call`, inbound requests from
other peers are queued and will surface as user prompts after the call
returns — you cannot handle them concurrently.

`peer offline` and `timeout` are normal failure modes, not errors to
retry — there is no offline queue or retry mechanism.
