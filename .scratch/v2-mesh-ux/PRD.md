# PRD-V2: Mesh UX — TUI entry, supervisor Sage, breed-named instances visible in logs

> **Status: draft — needs grill session before issues can be filed.**
>
> Both items below were flagged by the project owner during the live demo
> of PRD-0001 V1 (PR #72). They are out of scope for V1 — V1 ships a
> bare-log Kanban-driven mesh, which is the right minimum-viable shape
> for the AFK trunk demo. V2 layers a TUI entry point and richer
> supervision on top.

## Problem statement

After PRD-0001 V1 ships, the Ralph-Loop mesh runs as a non-LLM control
plane (the Kanban) spawning headless Foremen via pi print mode. The
visible interface is a stream of plain-text log lines:

```
[kanban] dispatching Foreman for v1-fixture/01-trivial
[foreman:01-trivial] …model output…
[kanban] Foreman exited (code=0 …)
```

That works for AFK proof-of-life, but it falls short on two axes:

1. **Bare logs are not the right entry point.** Even in mesh mode, the
   user's primary touch point should be the pi TUI — same surface they
   get from `npm run agent`. Right now `npm run mesh` skips the TUI
   entirely; the user only ever sees stdout/stderr from worker
   processes. Mid-loop questions and inspection have nowhere to land.
2. **Foremen and Workers are not visibly named.** The runner generates
   a `<breed>-<shortName>` slug per instance (per AGENTS.md), but the
   kanban's stdout prefix is just the issue's NN-slug
   (`[foreman:01-trivial]`). The breed-name never surfaces in the log.
   Headless mode also skips the agent-header rail that would render
   the breed name in a TUI.

## Open questions for the grill

### A. TUI entry as the primary mesh interface

- Should `npm run mesh` launch the user into a pi TUI session that hosts
  a Sage-tier supervisor (RABBIT_SAGE_MODEL? LEAD_HARE_MODEL?) instead of
  exiting after spawning the Kanban?
- The Sage's role: field easier questions from Foremen mid-loop ("which
  approach do you prefer?", "is this commit message OK?") and only
  escalate to the user when judgment is genuinely required.
- What's the action graph? Foreman → Sage (always tries first); Sage →
  user (only on escalate). This mirrors the `respond_to_request` /
  supervisor-inbox pattern from ADR-0003 — the Sage is just another
  supervisor in that chain.
- Open: where does the Kanban live in this picture? Still its own
  long-lived peer? Spawned by the Sage as an extension? A non-LLM
  child of the Sage's pi session?

### B. TUI elements for Foreman inspection

- The user should be able to see what each Foreman is currently doing
  without grep'ing log streams. Candidate UI elements:
  - A live-updating panel listing each Foreman with: breed-name,
    issue, current step (claim / TDD / reintegrate / close), elapsed
    time.
  - A way to "drill into" a specific Foreman's session log without
    losing the supervisor's TUI.
  - An inline approval prompt when a Foreman submits a question to the
    Sage that the Sage chose to escalate.
- The existing `agent-status-reporter` / `delegation-boxes` widget
  (deferred from V1 per `docs/agents.md`) is the natural starting
  point — V2 might be where it actually lands.

### C. Breed names visible in mesh logs

- Smaller, partly orthogonal: even before the TUI lands, the Kanban's
  stdout prefix should use the breed-name the runner generates
  (`[cottontail-foreman]` instead of `[foreman:01-trivial]`).
- Two implementation options:
  1. Have the kanban deterministically pre-generate the breed-name
     before spawning, and pass it as `--agent-name` (kanban prints
     `[cottontail-foreman: 01-trivial] …`).
  2. Have the runner echo its generated agent-name to stdout on a
     known prefix, and have the kanban capture it for re-prefixing
     subsequent lines.
- Option 1 is cleaner; option 2 keeps the runner authoritative on
  naming. The grill should pick one.

## Out of scope

- Anything that requires changing the V1 V1 spec retroactively. V1
  ships the bare-log Kanban; V2 layers on top.
- Replacing the Kanban with an LLM. The Kanban being non-LLM is an
  ADR-0005 commitment.
- Changing the print-mode Foreman model. V2 might add a TUI Foreman
  variant for interactive sessions, but the Kanban-spawned headless
  Foreman stays.

## Further notes

- Surfaced during the live-demo testing of PR #72 (PRD-0001 #03). See
  the conversation thread on that PR for the original flags.
- Likely overlaps with unresolved questions in ADR-0003 (supervisor in
  review loop) about which tier(s) make good supervisors.
