# AgentFactory

A workspace for designing, building, and stress-testing **pi agents** —
custom extensions for [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono).

## Goals

- **Make agent authorship cheap.** A short natural-language prompt should
  be enough to produce a correct, safe pi extension. The heavy lifting
  lives in the `pi-agent-builder` skill so the human doesn't have to
  re-derive boilerplate, safety rails, or lifecycle plumbing each time.
- **Keep agent authorship portable.** The builder skill is expected to
  work well on every model in `AGENT_BUILDER_TARGETS` (currently Haiku
  4.5, Gemini 3 Flash Preview, GLM 5.1) — not just on a single
  frontier model. Skill refinements are validated against all targets.
- **Standardize the model tiering.** Every agent in this repo picks
  from three named tiers (`PLAN_MODEL`, `LEAD_MODEL`, `TASK_MODEL`) so
  cost-vs-capability tradeoffs are explicit and swappable in one
  place (`models.env`).
- **Enforce sub-agent safety by default.** Any extension that spawns a
  child pi process inherits the same rails: `--no-extensions`, a tight
  `--tools` allowlist, parent-forwarded `AbortSignal`, and bounded
  captured output. The `pi-agent-builder` references encode these so
  every generated agent gets them for free.
- **Provide worked references, not just docs.** Two live extensions
  (`deferred-writer`, `delegated-writer`) cover the two patterns —
  single-task drafter and orchestrator-over-extension — so new agents
  can be built by analogy rather than from scratch.

## Where to go next

- **Building or running agents:** see [`AGENTS.md`](./AGENTS.md) for the
  full workflow, repo layout, and the gotchas we've already paid for.
- **Model IDs and tiers:** see [`models.env`](./models.env).
- **Reference agents:** `pi-sandbox/.pi/extensions/deferred-writer.ts`
  and `pi-sandbox/.pi/extensions/delegated-writer.ts`.
- **Builder skill:** `pi-sandbox/skills/pi-agent-builder/`.
