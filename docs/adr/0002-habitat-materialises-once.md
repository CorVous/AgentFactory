# Habitat materialises once; rails read from a shared spec

A peer's containment perimeter — scratch FS, peer allowlists, supervisor, submitTo, tools, model — is resolved once at `session_start` by a `Habitat` module from recipe + topology + flags, then exposed to every rail. Existing rails (`sandbox.ts`, `no-edit.ts`, peer-allowlist, supervisor handler) read the axis they enforce from the materialised Habitat instead of re-parsing CLI flags and env vars themselves.

## Why

- **One answer to "what are this peer's bounds."** Today the perimeter is reconstructed implicitly across many files because `pi.getFlag` is scoped per-extension, forcing the runner to mirror flags into env vars and forcing each rail to re-parse them. Adding a new rail (peer-allowlist, supervisor handler) under the same pattern would deepen the homelessness, not fix it.
- **Locality without a mega-rail.** Folding every axis (FS, no-edit, allowlists, supervisor) into one Habitat rail conflates "what is the perimeter" with "how each axis is enforced." Those change at different frequencies — perimeter resolution rules change with the recipe schema; per-axis enforcement hooks change with pi's event surface. Splitting them keeps each concern testable on its own.
- **A clean home for new fields.** `supervisor`, `submitTo`, `acceptedFrom`, group bindings, and any future axis attaches to one typed shape rather than growing the flag soup.

## Considered alternatives

- **One Habitat rail subsumes everything** (FS, no-edit, allowlists, supervisor handler all in one extension). Rejected: every change touches one file; per-axis testability suffers.
- **Habitat is doc-only; rails stay split exactly as today.** Rejected: this is the homelessness pattern the original deepening surfaced; nothing actually changes in the code.

## Consequences

- The runner stops mirroring flags into `PI_AGENT_NAME` / `PI_AGENT_BUS_ROOT` / `PI_AGENT_SKILLS` / `PI_AGENT_AGENTS` / `PI_RPC_SOCK` env vars; it serialises the resolved Habitat into one `--habitat-spec <json>` flag.
- `sandbox.ts` and `no-edit.ts` slim; their flag-parsing collapses into "ask the Habitat for `scratchRoot`."
- The Habitat is the read-source for `delegation-boxes`, `agent-footer`, `agent-header` — they stop reaching across env vars.
- New rails added in later phases (peer-allowlist, supervisor inbound handler) read their axis from the same Habitat without inventing their own flags.
