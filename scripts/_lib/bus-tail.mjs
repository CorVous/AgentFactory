/**
 * bus-tail.mjs — bus-tail overlay state and ANSI rendering.
 *
 * Maintains a FIFO buffer (cap 200) of bus envelopes flowing on the mesh.
 * Renders as a top-strip overlay above the multiplexer: does NOT shrink
 * the focused peer's pane — the overlay renders above the pane on stderr.
 *
 * Filter helpers:
 *   - No filter (undefined/empty) → show all envelopes.
 *   - String filter → show only envelopes whose `envKind` matches.
 *     Common filters: "submissions", "messages", "approval-request".
 *     "submissions" maps to "submission" (singular) for user convenience.
 *
 * ANSI rendering is deterministic for fixed input — easy to test.
 */

// ANSI escape helpers (same palette as chrome.mjs)
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const WHITE = "\x1b[37m";

/** Maximum number of tail entries to buffer (FIFO drop on overflow). */
export const TAIL_BUFFER_MAX = 200;

/**
 * @typedef {{
 *   sender: string;
 *   recipient: string;
 *   envKind: string;
 *   body: string;
 *   ts: number;
 * }} TailEntry
 */

/**
 * BusTailBuffer — append-only FIFO buffer with cap enforcement.
 */
export class BusTailBuffer {
  constructor() {
    /** @type {TailEntry[]} */
    this._entries = [];
  }

  /**
   * Push a new tail entry. FIFO-drops the oldest when over cap.
   *
   * @param {TailEntry} entry
   */
  push(entry) {
    this._entries.push(entry);
    if (this._entries.length > TAIL_BUFFER_MAX) {
      this._entries.shift(); // FIFO drop
    }
  }

  /**
   * Return all entries, optionally filtered by envelope kind.
   *
   * @param {string | undefined} filter
   * @returns {TailEntry[]}
   */
  getEntries(filter) {
    const normalised = normaliseFilter(filter);
    if (!normalised) return this._entries.slice();
    return this._entries.filter((e) => e.envKind === normalised);
  }

  /**
   * Total entries buffered (unfiltered).
   *
   * @returns {number}
   */
  size() {
    return this._entries.length;
  }

  /**
   * Empty the buffer.
   */
  clear() {
    this._entries.length = 0;
  }
}

/**
 * Factory function.
 *
 * @returns {BusTailBuffer}
 */
export function createBusTailBuffer() {
  return new BusTailBuffer();
}

/**
 * Normalise a user-supplied filter string to a canonical envelope kind.
 * "submissions" → "submission" (user-friendly plural alias).
 * "messages"   → "message".
 * All others are passed through as-is.
 *
 * @param {string | undefined} filter
 * @returns {string | undefined}
 */
export function normaliseFilter(filter) {
  if (!filter || !filter.trim()) return undefined;
  const f = filter.trim().toLowerCase();
  if (f === "submissions") return "submission";
  if (f === "messages") return "message";
  return f;
}

/**
 * Colour an envelope kind for the overlay display.
 *
 * @param {string} kind
 * @returns {string}
 */
function colourKind(kind) {
  switch (kind) {
    case "message":          return `${GREEN}${kind}${RESET}`;
    case "submission":       return `${CYAN}${kind}${RESET}`;
    case "approval-request": return `${YELLOW}${kind}${RESET}`;
    case "approval-result":  return `${YELLOW}${kind}${RESET}`;
    case "revision-requested": return `${MAGENTA}${kind}${RESET}`;
    default:                 return `${DIM}${kind}${RESET}`;
  }
}

/**
 * Truncate a string to maxLen, appending '…' if truncated.
 *
 * @param {string} s
 * @param {number} maxLen
 * @returns {string}
 */
function trunc(s, maxLen) {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

/**
 * Render the bus-tail overlay as a multi-line ANSI string.
 *
 * @param {{
 *   entries: TailEntry[];
 *   active: boolean;
 *   filter?: string;
 *   maxRows?: number;
 * }} opts
 * @returns {string}
 */
export function renderBusTailOverlay(opts) {
  const { entries, active, filter, maxRows = 10 } = opts;
  const lines = [];

  // Header bar
  const filterLabel = filter ? ` [${filter}]` : "";
  const statusStr = active ? `${GREEN}● active${RESET}` : `${DIM}○ off${RESET}`;
  lines.push(
    `${BOLD}${CYAN}Bus Tail${RESET}${filterLabel}  ${statusStr}  ${DIM}(${entries.length} envelopes)${RESET}`,
  );
  lines.push(`${DIM}${"─".repeat(60)}${RESET}`);

  if (!active && entries.length === 0) {
    lines.push(`${DIM}  Use /tail to enable bus monitoring.${RESET}`);
    return lines.join("\n") + "\n";
  }

  if (entries.length === 0) {
    lines.push(`${DIM}  (no envelopes yet)${RESET}`);
    return lines.join("\n") + "\n";
  }

  // Show the most recent maxRows entries (newest last, like a log tail).
  const visible = entries.slice(-maxRows);
  for (const e of visible) {
    const time = new Date(e.ts).toISOString().slice(11, 23); // HH:MM:SS.mmm
    const sender = trunc(e.sender, 12);
    const recipient = trunc(e.recipient, 12);
    const kind = colourKind(e.envKind);
    const body = trunc(e.body, 30);
    lines.push(
      `  ${DIM}${time}${RESET}  ${WHITE}${sender}${RESET}${DIM}→${RESET}${WHITE}${recipient}${RESET}  ${kind}  ${DIM}${body}${RESET}`,
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * Strip ANSI escape sequences from a string (for testing).
 *
 * @param {string} s
 * @returns {string}
 */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
