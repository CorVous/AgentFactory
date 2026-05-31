# Testing & debugging agents

Parent: [`docs/agents.md`](../agents.md).

## Debugging the rails

Pass `--debug` when launching an agent and the `sandbox` and `no-edit`
extensions will dump their resolved tool sets via `ctx.ui.notify` on
`session_start`. Useful when you've added a new write tool and want to
confirm it was picked up by introspection.

The rails — `agent-header`, `agent-footer`, and `deferred-confirm`'s
end-of-turn `ctx.ui.confirm` dialog — only render under a real PTY,
so `pi -p` print mode can't exercise them. For integration testing,
drive a full TUI session under tmux:

```sh
set -a; source models.env; set +a
tmux new-session -d -s pi-test -x 200 -y 50 \
  'pi --recipe deferred-writer --debug'
sleep 5                                              # let pi boot + print debug
tmux send-keys -t pi-test 'draft hello.txt saying hi' Enter
sleep 30                                             # wait for the model
tmux capture-pane -t pi-test -p                       # snapshot the screen
tmux send-keys -t pi-test 'y' Enter                   # approve deferred_write dialog
sleep 5
tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test '/quit' Enter
```

Caveats: this hits the real model so each run costs a fraction of a
cent, and `capture-pane -p` returns plain text — colors and bold from
`agent-header` won't show up in the snapshot.

## Unit tests (`npm test`)

Unit tests live alongside source files as `*.test.ts` and run via
`npm test` (vitest). They are **hermetic by contract**: no model API
calls, no network, no env vars from `models.env`, no real filesystem
outside the test's tmpdir. Tests that need a live model belong in the
tmux integration pattern above, not in `npm test`. Run `npm run
test:watch` for a red-green-refactor loop while iterating on a pure
library module.

Unit tests run automatically in CI on every push and PR; tmux integration tests stay local.

## Verifying the multi-agent rails

The preferred way to run and observe a live multi-agent mesh is via the
launcher TUI (`npm run mesh`). The launcher multiplexes every peer's pi
session into one terminal: the focused peer's PTY is rendered live in
the main pane, with a single-line mesh-status widget (peer name, peer
count, decisions count) pinned directly above the input editor by the
auto-loaded `mesh-rail` baseline extension. Bus-tail output and the
decisions queue surface via slash commands (`/tail`, `/decisions`) — the
launcher itself emits no chrome. The human is not a peer — there is no
`human-relay` process; the launcher is the human's sole interface.

```sh
set -a; source models.env; set +a
# Write a minimal two-peer topology (planner + worker-a) and launch it:
cat > /tmp/chat-mesh.yaml <<'EOF'
entry: planner
nodes:
  - name: planner
    recipe: peer-chatter
    sandbox: /tmp/p1
    peers: [worker-a]
  - name: worker-a
    recipe: peer-chatter
    sandbox: /tmp/p2
    supervisor: planner
    peers: [planner]
EOF
npm run mesh -- /tmp/chat-mesh.yaml
# The launcher opens with "planner" focused.
# Use /focus worker-a  to switch to the worker's pane.
# Use /tail             to stream the inter-peer bus traffic.
# Type a message in any peer pane; it lands in that peer's pi session.
```

The launcher wire format is documented in
`scripts/_lib/launcher-envelope.mjs` — consult that file when writing
extensions that emit control envelopes (focus-request, pin-request,
decisions-jump, tail-event, etc.).

To exercise the **atomic delegate** end-to-end, drive
`writer-foreman` (single file):

```sh
set -a; source models.env; set +a
mkdir -p /tmp/foreman-test
tmux new-session -d -s foreman -x 200 -y 50 \
  'pi --recipe writer-foreman --sandbox /tmp/foreman-test --debug'
sleep 5
tmux send-keys -t foreman \
  'draft hello.txt with text "Hi"' Enter
sleep 60                              # foreman calls delegate; worker drafts and
                                      # ships submission; foreman queues artifacts;
                                      # end-of-turn approval renders.
tmux capture-pane -t foreman -p       # expect a Delegate (...) section in the
                                      # approval preview.
tmux send-keys -t foreman 'y' Enter   # approve at end-of-turn dialog
sleep 5
ls /tmp/foreman-test/hello.txt        # file present with "Hi"
tmux send-keys -t foreman '/quit' Enter
```

For **multiple delegates in one turn** (each surfaces as a separate
section in the unified preview):

```sh
tmux send-keys -t foreman \
  'draft two files: hello.txt saying "Hi" and world.txt saying "World"' Enter
sleep 120   # foreman calls delegate twice; both submissions queue;
            # one unified end-of-turn dialog shows both Delegate sections.
tmux send-keys -t foreman 'y' Enter
sleep 5
ls /tmp/foreman-test/   # hello.txt and world.txt both present
```

Negative cases worth probing manually:

- **Loud fail under print mode**: run `pi --recipe deferred-writer
  -p "draft x.txt"` directly. With no UI, the worker exits but stderr
  contains `[deferred] dropped: no UI available`. (Cross-agent
  approval forwarding now flows over the bus, not through `--rpc-sock`.)
- **Recipe not allowed**: prompt foreman with `recipe:
  "deferred-editor"` → `delegate: recipe 'deferred-editor' not in
  this agent's allowed list [deferred-writer]`.
- **Missing cluster**: a recipe listing `extensions: [deferred-write]`
  when `@agentfactory/deferred-rails` is not installed → engine errors
  with a `pi install npm:@agentfactory/deferred-rails` hint.
