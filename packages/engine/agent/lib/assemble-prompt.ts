// assemble-prompt.ts — assembles the final system prompt from extension fragments
// and the recipe's own prompt text.
//
// Pure: no file I/O. Fragment reading is injected via the `readFragment` callback
// so this module remains hermetic and fully unit-testable.
//
// Conditional gating rules (ported from loadPromptFragments in scripts/run-agent.mjs):
//   - `deferred-confirm` fragment is only prepended when at least one other
//     `deferred-*` extension (i.e. not `deferred-confirm` itself) is active.
//     Rationale: the fragment documents apply-order and atomic batch semantics,
//     which are only relevant when a deferred tool is loaded.
//   - `supervisor` and `intercept` fragments are only prepended when
//     `hasSupervisoryHabitat` is true — i.e. the resolved Habitat has any
//     supervisory peer field set (acceptedFrom non-empty, or supervisor/submitTo
//     is set). This is evaluated AFTER the topology overlay is merged.
//
// Missing fragments are silently skipped (readFragment returns null/undefined).

export interface AssemblePromptOptions {
  /**
   * The full list of active extension names (template chain + recipe, deduped).
   * Used to determine conditional fragment inclusion.
   */
  extensionNames: string[];

  /** The recipe's own system prompt text (already trimmed). */
  recipePrompt: string;

  /**
   * Optional per-instance task text appended after the recipe prompt.
   * Used by topology node `task:` fields.
   */
  taskText?: string;

  /**
   * Whether the resolved Habitat has any supervisory peer fields set
   * (acceptedFrom non-empty, or supervisor/submitTo is set).
   * Controls whether `supervisor` and `intercept` fragments are included.
   */
  hasSupervisoryHabitat: boolean;

  /**
   * Injected I/O callback: given an extension name, returns the fragment text
   * (trimmed), or null/undefined if the fragment file does not exist.
   *
   * Keeping I/O out of this module makes it fully hermetic for unit tests.
   */
  readFragment: (extensionName: string) => string | null | undefined;
}

/**
 * Assembles the final system prompt from extension fragments and the recipe prompt.
 *
 * Fragment order: extension fragments (in extensionNames order, gated) →
 * recipe prompt → optional task text. Sections are joined with `\n\n`.
 *
 * Returns the assembled prompt string (never empty — recipePrompt is required).
 */
export function assemblePrompt(opts: AssemblePromptOptions): string {
  const { extensionNames, recipePrompt, taskText, hasSupervisoryHabitat, readFragment } = opts;

  // Determine if any deferred-* tool extension (other than deferred-confirm) is active.
  const hasDeferredTool = extensionNames.some(
    (n) => n.startsWith("deferred-") && n !== "deferred-confirm",
  );

  const parts: string[] = [];

  // Collect extension fragments in order, applying conditional gating.
  for (const name of extensionNames) {
    if (name === "deferred-confirm" && !hasDeferredTool) continue;
    if ((name === "supervisor" || name === "intercept") && !hasSupervisoryHabitat) continue;

    const fragment = readFragment(name);
    if (fragment != null && fragment.trim().length > 0) {
      parts.push(fragment.trim());
    }
  }

  // Recipe prompt is always appended (required, already trimmed by caller).
  parts.push(recipePrompt);

  // Optional task text comes last.
  if (taskText != null && taskText.trim().length > 0) {
    parts.push(taskText.trim());
  }

  return parts.join("\n\n");
}
