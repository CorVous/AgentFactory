import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Curation } from "./curation.ts";
import { GAP_SEEDS } from "./gap-seeds.ts";

export interface GenerateOptions {
  repoRoot: string;
  /** OpenRouter model id, e.g. process.env.LEAD_MODEL. */
  model: string;
  /** Generation timeout per variant, in ms. */
  timeoutMs?: number;
  /** How many variants to sample; the best by heuristic is returned. */
  nVariants?: number;
  /** Temperature override; defaults differ for assembly vs gap. */
  temperature?: number;
}

export interface GenerateResult {
  prompt: string;
  /** All raw variants, indexed. Useful for logging / --dry-run. */
  variants: string[];
  /** Index of the chosen variant in `variants`. */
  chosenIndex: number;
  /** Actual temperature used. */
  temperature: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_N_VARIANTS = 3;

/**
 * Generate a short natural-language user prompt from a curation. Uses
 * the `pi` CLI in print mode with `--no-tools` so pi acts purely as
 * a completion endpoint (no agent loop, no tool calls, no LLM
 * exploration). We take N samples and pick the one with the least
 * surface-form overlap with the pattern / component vocabulary, to
 * avoid trivially-classifiable prompts.
 */
export function generatePrompt(curation: Curation, opts: GenerateOptions): GenerateResult {
  const nVariants = opts.nVariants ?? DEFAULT_N_VARIANTS;
  const temperature = opts.temperature ?? (curation.kind === "gap" ? 1.0 : 0.6);
  const system = buildSystemPrompt(curation);
  const user = buildUserPrompt(curation);

  const variants: string[] = [];
  for (let i = 0; i < nVariants; i++) {
    const text = runPi(system, user, opts.model, opts.repoRoot, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    variants.push(text);
  }
  const chosenIndex = pickLeastLeakyVariant(variants, curation);
  return { prompt: variants[chosenIndex], variants, chosenIndex, temperature };
}

function buildSystemPrompt(curation: Curation): string {
  const base = [
    "You are writing a short user request that a developer might type",
    "when they want a new pi agent. The user is asking for a TOOL to be",
    "BUILT — an agent they can run later — not for the underlying job",
    "to be performed right now. A downstream skill will classify the",
    "request and assemble an agent from components.",
    "",
    "Rules:",
    "- Frame the ask as a request to BUILD an agent / tool / command.",
    "  Start with phrases like 'I want an agent that…', 'Build me a",
    "  tool that…', 'I need a command that…', 'Write me an agent",
    "  that…'. NEVER frame it as 'do this task for me now' or",
    "  'help me with X' — that reads as a direct task request and",
    "  breaks classification downstream.",
    "- Describe the JOB the agent should do, in natural developer",
    "  language. Do NOT describe the implementation.",
    "- Do NOT name any pattern, component, tool, or pi-specific vocabulary",
    "  (e.g. do NOT say: 'stage', 'emit-summary', 'cwd-guard', 'drafter',",
    "  'scout', 'orchestrator', 'recon', 'confined', 'stub', 'harvest').",
    "- Do NOT describe internals (spawn, stdout, json events, --tools,",
    "  --mode, etc).",
    "- 2 to 4 sentences. Plain English. No bullet lists.",
    "- Output ONLY the user request text. No preamble, no quoting,",
    "  no 'Here's the prompt:' wrapper.",
  ].join("\n");

  if (curation.kind === "gap") {
    const ctx = GAP_SEEDS.find((g) => g.seed === curation.phrasingSeed);
    const why = ctx?.why
      ? `\n\nContext (do not include in output): ${ctx.why}`
      : "";
    return `${base}\n\nThe request should describe something realistic but OUT OF THE LIBRARY — a user asking for an agent the skill cannot assemble from its current parts. The phrasing should be believable, not deliberately weird. Still frame it as 'I want an agent that…'.${why}`;
  }

  return `${base}\n\nThe intended target pattern (do NOT name it in your output) is: ${curation.pattern}. It expects these components to be loaded: ${curation.components.join(", ") || "(none)"}. Phrase the request so a careful human would classify it as that pattern without being told.`;
}

function buildUserPrompt(curation: Curation): string {
  return `Seed idea: ${curation.phrasingSeed}\n\nWrite the user request now. Output only the request text, 2–4 sentences.`;
}

/**
 * Spawn pi in print mode + JSON mode, feed the system + user prompt,
 * and pull the final assistant message out of the NDJSON stream.
 *
 * Notes on pi flags (see AGENTS.md "Scripted (non-interactive) pi
 * invocations"): --no-tools avoids spontaneous bash/read loops;
 * --no-skills / --no-extensions / --no-session keep the completion
 * pure; --no-context-files suppresses AGENTS.md / CLAUDE.md; --mode
 * json lets us read message_end reliably instead of depending on
 * text-mode buffering.
 */
function runPi(
  system: string,
  user: string,
  model: string,
  repoRoot: string,
  timeoutMs: number,
): string {
  const piBin = path.join(repoRoot, "node_modules/.bin/pi");
  const result = spawnSync(
    piBin,
    [
      "--no-context-files",
      "--no-session",
      "--no-skills",
      "--no-extensions",
      "--no-tools",
      "--thinking",
      "off",
      "--provider",
      "openrouter",
      "--model",
      model,
      "--system-prompt",
      system,
      "--mode",
      "json",
      "-p",
      user,
    ],
    {
      env: {
        ...process.env,
        PI_SKIP_UPDATE_CHECK: "1",
        PATH: `${path.join(repoRoot, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const tail = (result.stderr ?? "").slice(-500);
    throw new Error(
      `pi exited ${result.status} during prompt generation: ${tail.replace(/\n/g, " ").trim()}`,
    );
  }
  return extractFinalMessage(result.stdout ?? "");
}

function extractFinalMessage(stdout: string): string {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  // Walk in reverse; first message_end with text content wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    let event: unknown;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const e = event as Record<string, unknown>;
    if (e.type !== "message_end") continue;
    const msg = e.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const content = msg.content;
    const text = flattenContent(content);
    if (text.trim().length > 0) return text.trim();
  }
  throw new Error(
    `Could not extract final assistant message from pi stdout (${lines.length} event lines).`,
  );
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

/**
 * Lower score = less leaky. Scored by count of prohibited tokens
 * (pattern name, component names, pi-vocabulary). Ties broken by
 * preferring the shortest variant (proxy for "cleaner phrasing").
 */
export function pickLeastLeakyVariant(variants: string[], curation: Curation): number {
  const forbidden = forbiddenTokens(curation);
  let best = 0;
  let bestScore = Infinity;
  variants.forEach((v, i) => {
    const lc = v.toLowerCase();
    let hits = 0;
    for (const tok of forbidden) {
      if (lc.includes(tok)) hits++;
    }
    const score = hits * 1000 + v.length; // hits dominate; length is a mild tiebreaker
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function forbiddenTokens(curation: Curation): string[] {
  const base = [
    "stage",
    "emit-summary",
    "emit_summary",
    "cwd-guard",
    "scout",
    "orchestrator",
    "recon",
    "confined",
    "drafter",
    "stub",
    "harvest",
    "pi extension",
    "pi-extension",
    "--tools",
    "stage_write",
    "run_deferred_writer",
  ];
  if (curation.pattern && curation.pattern !== "gap") {
    base.push(curation.pattern);
  }
  for (const c of curation.components) {
    const bare = c.replace(/\.ts$/, "");
    base.push(bare);
    base.push(bare.replace(/-/g, "_"));
  }
  return dedupe(base.map((t) => t.toLowerCase()));
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
