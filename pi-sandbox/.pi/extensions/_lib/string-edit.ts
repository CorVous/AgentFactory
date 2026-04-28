// Shared string-edit helpers.
//
// applyUnique: apply a single-occurrence string replacement.
// Used by both deferred-edit.ts (worker-side queuing) and
// submission-apply.ts (supervisor-side apply pass).

/** Replace the unique occurrence of `oldString` in `content` with `newString`.
 *  Returns an error descriptor when:
 *   - oldString is empty
 *   - oldString is not found
 *   - oldString matches more than once
 */
export function applyUnique(
  content: string,
  oldString: string,
  newString: string,
): { ok: true; out: string } | { ok: false; err: string } {
  if (oldString.length === 0) return { ok: false, err: "oldString is empty" };
  const idx = content.indexOf(oldString);
  if (idx < 0) return { ok: false, err: "oldString not found in content" };
  if (content.indexOf(oldString, idx + 1) >= 0)
    return { ok: false, err: "oldString matches multiple times; add surrounding context to make it unique" };
  return { ok: true, out: content.slice(0, idx) + newString + content.slice(idx + oldString.length) };
}
