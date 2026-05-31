# Rails reference — baseline extensions & cluster packages

Parent: [`docs/agents.md`](../agents.md).

Every agent launched via `pi --recipe` gets the engine-baseline
extensions automatically. The generic rails are split across three
independently-installable cluster packages.

## Baseline extensions

- `sandbox` — blocks `bash` outright and rejects any path-bearing tool
  call whose `path` resolves outside the sandbox root. The set of
  path-bearing tools is discovered at session start from
  `pi.getAllTools()` (any tool whose schema declares `path: string`),
  with a static fallback of `{read, write, edit, ls, grep, find}` for
  the installed pi 0.75 built-ins. Owns the `--sandbox-root <path>`
  flag (read by `agent-footer`, `deferred-write`, and `no-edit` via
  `pi.getFlag`); falls back to `ctx.cwd` when the flag is unset.
  Ships in `@agentfactory/containment-rails`.
- `no-startup-help` — suppresses pi's default startup header (logo,
  keybinding cheatsheet, onboarding tips) since most of those keybindings
  reference features focused agents don't use. Ships in
  `@agentfactory/ui-rails`.
- `agent-header` — replaces the (now-empty) header with a banner that
  shows the agent's full display name (bold accent) — the breed from
  the `<breed>-<shortName>` slug joined with the prettified recipe
  filename, e.g. `Cottontail Deferred Writer` — optionally suffixed
  dim with the model tier (e.g. `· Task Rabbit`), and the recipe's
  `description:` field on the next line (dim). Ships in
  `@agentfactory/ui-rails`.
- `agent-footer` — replaces pi's default footer. Line 1 shows the
  sandbox root on the left and the comma-separated active tools (from
  `pi.getActiveTools()`, i.e. the recipe's `tools:` allowlist plus any
  extension-registered tools) on the right. Line 2 (when populated) shows
  the recipe's `skills:` list on the left and the recipes this agent may
  spawn via `mesh_spawn` on the right — both as plain comma-separated
  lists, no labels, matching line 1's bare style. Reads both from
  `getHabitat()`; the line is skipped entirely when both lists are empty.
  Line 3 shows
  `$cost` and the context-usage percent on the left, model id on the
  right — pi's default token-flow stats (↑input, ↓output, cache R/W,
  context window size) are intentionally dropped. Line 4 is the
  extension-status line. Ships in `@agentfactory/ui-rails`.
- `hide-extensions-list` — strips pi's `[Extensions]` section (added by
  `showLoadedResources` to the chat history at startup) since the
  agent-footer already shows the active tools and the path listing is
  noise. Reaches into private TUI state via `setWidget`+`setTimeout(0)`
  because pi has no public API to suppress per-section. Ships in
  `@agentfactory/ui-rails`.
- `deferred-confirm` — end-of-turn coordinator for any `deferred-*`
  extension. Exposes `registerDeferredHandler({ label, extension,
  priority, prepare })` (named export) plus a single `agent_end` listener
  that calls every registered handler's `prepare(ctx)`, aggregates the
  results into one approval prompt (sections grouped by handler label,
  summary line in the title), and on approval invokes each handler's
  `apply()` in priority order (10 writes → 20 edits → 25 moves → 30
  deletes). Any handler returning `status: "error"` aborts the entire
  batch before the prompt renders. The handler array is stashed on
  `globalThis` so it survives jiti's per-extension module isolation
  (`loader.js` uses `moduleCache: false`). No-op for agents that don't
  load any deferred-* extension — when no handlers register,
  `agent_end` returns silently.

  **Approval routing** is handled by an exported helper in
  `_lib/escalation.ts`,
  `requestHumanApproval(ctx, pi, {title, summary, preview}) →
  Promise<boolean>`. After Phase 5 the routing is:
  - `ctx.hasUI` → renders `ctx.ui.confirm` locally (this terminal is
    the human's).
  - else loud-fails to stderr (`[deferred] dropped: no UI available`)
    and returns `false`.

  Cross-agent escalation now flows over the bus as a typed
  `approval-request` envelope handled by the supervisor rail (see
  [`multi-agent.md`](./multi-agent.md)) rather than over per-call
  Unix sockets.

  When no UI is present, the apply-loop's status notifications
  (`writes applied: …`, `edits applied: …`, etc.) are routed to
  stdout as `[deferred] …` lines so any wrapping process that
  captures the worker's stdout still sees them.

## Packaging — engine and cluster packages

`@agentfactory/pi-engine` is the always-on package: it ships the
`recipe-loader` extension (which registers `--recipe` and the eight launch
flags) plus the full mesh subsystem (`peer-bus`, `mesh-mux`, `mesh-spawn`,
`supervisor`, `intercept`, `launcher-bridge`, `slash-commands`,
`bus-tail-emitter`, `mesh-rail`). It loads on every `pi` invocation but is
**loaded-but-inert** — with no `--recipe` flag, raw `pi` behaves like
vanilla pi.

Three independently-installable **cluster packages** ship the generic rails:

| Package | Rails included |
| --- | --- |
| `@agentfactory/deferred-rails` | `deferred-confirm`, `deferred-write`, `deferred-edit`, `deferred-move`, `deferred-delete` |
| `@agentfactory/containment-rails` | `sandbox`, `no-edit` |
| `@agentfactory/ui-rails` | `agent-header`, `agent-footer`, `no-startup-help`, `hide-extensions-list` |

Each cluster depends only on `@agentfactory/pi-engine` — a star topology
with no inter-cluster edges. A recipe that references a rail from an
uninstalled cluster hard-errors with a `pi install npm:@agentfactory/<cluster>`
hint.

## Missing rail cluster — hard error

If a recipe lists an extension whose owning cluster package is not
installed, the engine refuses to start the session with a clear message:

```
recipe-loader: missing rail cluster(s):
  rail 'deferred-write' requires cluster 'deferred-rails' — install with: pi install npm:@agentfactory/deferred-rails
```

Install the named cluster and retry. Never silently skip a missing rail
(skipping `sandbox` would disable FS containment without warning).
