/**
 * Hand-seeded phrasings for out-of-library agent requests. Each seed
 * should be a job the current 5×5 library does NOT cover, so the
 * assembler skill's correct response is the normalized GAP message
 * with `closestMatch` identifying the nearest pattern (or "none").
 *
 * Circular-reasoning guard: these are hand-written, not LLM-generated.
 * Letting the generator invent gap seeds risks producing prompts the
 * classifier trivially matches — defeating the point of the gap track.
 */

export interface GapSeed {
  /** Short English sketch the prompt generator paraphrases. */
  seed: string;
  /** Closest-match pattern name the assembler should name in its GAP message. */
  closestMatch: string;
  /** One-line note to the generator's system prompt about what this is. */
  why: string;
}

export const GAP_SEEDS: GapSeed[] = [
  {
    seed: "agent that fetches a URL over HTTP and summarizes the JSON response",
    closestMatch: "recon",
    why: "recon is read-only but scoped to the local filesystem; no http component exists.",
  },
  {
    seed: "agent that runs on a cron schedule and tails a log file for errors",
    closestMatch: "none",
    why: "no scheduling or watch-based component in the library; outside any pattern.",
  },
  {
    seed: "agent that streams LLM output into a live-updating custom TUI widget with a cancel button",
    closestMatch: "none",
    why: "custom TUI widgets and streaming output belong to pi-agent-builder, not the assembler.",
  },
  {
    seed: "two-stage LLM critique pipeline that scores existing files but never drafts or writes anything",
    closestMatch: "recon",
    why: "no write, no draft — but also no summary emission; pure reviewer role without a component.",
  },
  {
    seed: "agent that opens a long-running interactive chat session and remembers prior turns across invocations",
    closestMatch: "none",
    why: "session persistence across process boundaries is a pi-packages concern, not a pattern.",
  },
  {
    seed: "agent that executes arbitrary shell commands based on user intent and reports exit codes",
    closestMatch: "none",
    why: "no safe bash primitive in any pattern; explicitly out-of-scope for the assembler.",
  },
];
