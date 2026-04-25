import type { ComponentName } from "./component-spec.ts";

/**
 * Hand-mirrored signal → component table, derived from
 * `pi-sandbox/skills/pi-agent-builder/references/reading-short-prompts.md`.
 *
 * Keep in sync with the markdown table above. A parser-driven drift
 * test is planned in `parts-first-plan/60-open-questions.md §4`; until
 * it lands, this file is the single source of truth for the prompt
 * validator (`scripts/grader/validate-prompt.ts`).
 *
 * Each row's pattern matches a *signal*; the components are the
 * canonical mapping for that signal. The validator unions the matches.
 *
 * Note on `cwd-guard`: it's implicit for any write-capable shape and
 * is therefore not surfaced as a standalone signal here — the
 * validator special-cases it (declared `cwd-guard` is always allowed
 * even if not signal-derived, when any write-capable component is
 * declared).
 */

export interface SignalRow {
  pattern: RegExp;
  components: ReadonlyArray<ComponentName>;
  /** Short human-readable handle for error messages. */
  description: string;
}

export const SIGNAL_MAP: ReadonlyArray<SignalRow> = [
  // Recon / read-only / survey → emit-summary.
  // Word stems accept inflections (survey/surveys/surveyed/surveying,
  // summary/summaries/summarize/summarizing) so the composer's mirror
  // prompts — which inherit the assembler's wording verbatim — all
  // trigger this row.
  {
    pattern:
      /\b(read-only|survey\w*|recon|explor\w*|map out|index\w*|audit\w*|summar\w*)\b/i,
    components: ["emit-summary"],
    description: "recon-style read-only survey",
  },

  // Approval / confirm / preview → stage-write (parent gate).
  // `show me (the )?drafts?` covers "Show me the draft before saving"
  // alongside the existing "draft … show me" ordering.
  {
    pattern:
      /\b(after the user confirms?|with approval|the user (decides?|approves?)|preview before writing|stage,? then approve|draft .* (and )?show me|show me (the )?drafts?)\b/i,
    components: ["stage-write"],
    description: "user-approval gate over drafts",
  },

  // Buffered / staged / in-memory writes → stage-write
  {
    pattern:
      /\b(buffered|staged|staging|in[- ]memory|in[- ]?buffer|buffers? writes|writes? to (a )?file in buffer|don't actually write yet|writes? on approval|waits? for (the )?user to approve before|show me what it would do|approve before (the )?writes? go through)\b/i,
    components: ["stage-write"],
    description: "buffered / staged write semantics",
  },

  // Confined / sandboxed → cwd-guard
  {
    pattern:
      /\b(can'?t get outside|stays? inside|sandboxed to|scoped to (this )?(directory|dir)|confined (drafter|to)|inside (a )?sandbox|under .*\.pi|writes? (in|into|to) (the )?sandbox)\b/i,
    components: ["cwd-guard"],
    description: "sandbox / confined writes",
  },

  // Sequential phases — scout-then-draft style → emit-summary + stage-write.
  // `surveys?` (with optional plural s) and `draft\w*` as a second-phase
  // verb cover "surveys a directory, then drafts a new README.md".
  {
    pattern:
      /\b(two phases|first .{0,40} then|propose .{0,40} then commit|look at .{0,40} then write|surveys? .{0,40} (and|then) (add|write|generate|create|produce|draft\w*)|given what'?s there,? (produce|generate|write))\b/i,
    components: ["emit-summary", "stage-write"],
    description: "sequential phases (scout + draft)",
  },

  // Parallel fan-out → run-deferred-writer
  {
    pattern: /\b(in parallel|fan ?out|N tasks at once|multiple drafters|several drafters|parallel drafters)\b/i,
    components: ["run-deferred-writer"],
    description: "parallel drafter fan-out",
  },

  // Orchestrator / LLM-review → review + run-deferred-writer
  {
    pattern:
      /\b(orchestrate[sd]?|orchestrator|delegate[sd]? to|decides? how many|calls? .{0,30} N times|LLM picks the subtasks?|reviewer (approves?|revises?)|review (verdict|step)|have an LLM (review|check|approve)|break this into sub-?tasks)\b/i,
    components: ["review", "run-deferred-writer"],
    description: "orchestrator with LLM review",
  },

  // Single-drafter LLM review (no fan-out) → review (no run-deferred-writer)
  {
    pattern:
      /\b(LLM (gate|review)s? (the |each )?draft|automatic(ally)? approve|review before (saving|promoting|writing))\b/i,
    components: ["review"],
    description: "single-drafter LLM review",
  },
];

/**
 * Tokens a prompt may NOT contain — the prompt should not name the
 * components it expects. The agent has to *choose* them from the ask.
 */
export const FORBIDDEN_LITERALS: ReadonlyArray<string> = [
  "stage-write",
  "stage_write",
  "emit-summary",
  "emit_summary",
  "cwd-guard",
  "sandbox_read",
  "sandbox_ls",
  "sandbox_grep",
  "sandbox_glob",
  "sandbox_write",
  "sandbox_edit",
  "run_deferred_writer",
  "run-deferred-writer",
];

/**
 * Compute the inferred component set for a prompt. Returns the union
 * of every matched row's components.
 */
export function inferComponentsFromPrompt(prompt: string): Set<ComponentName> {
  const out = new Set<ComponentName>();
  for (const row of SIGNAL_MAP) {
    if (row.pattern.test(prompt)) {
      for (const c of row.components) out.add(c);
    }
  }
  return out;
}

export function findForbiddenLiterals(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  return FORBIDDEN_LITERALS.filter((lit) => lower.includes(lit.toLowerCase()));
}
