/**
 * chrome.mjs — right-rail ANSI rendering for the multi-peer launcher.
 *
 * Renders a vertical strip showing:
 *   - Mesh metadata header (bus_root, node count).
 *   - Per-peer row: state icon + focus indicator + peer name (+ exit info for crashed peers).
 *   - Auto-shift notice when a focused peer crash triggers a focus shift.
 *
 * Output is plain ANSI text, no third-party TUI library required. The
 * rendering is deterministic for fixed input, making it straightforward
 * to test.
 *
 * State icons:
 *   ● running (green)
 *   ○ spawning (yellow)
 *   ✗ exited  (red/dim)
 *   ✗ crashed (red bold) — non-zero exit code or signal
 *   ? unknown (dim)
 *
 * The focused peer's row is rendered with a bold accent color; others are dim.
 * Crashed peers show their exit code/signal next to the name.
 */

// ANSI escape helpers
const ESC = "\x1b[";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";

/**
 * @typedef {"spawning" | "running" | "exiting" | "exited" | "crashed" | "unknown"} PeerState
 */

/**
 * @typedef {{
 *   name: string;
 *   state: PeerState;
 *   exitCode?: number | null;
 *   exitSignal?: string | null;
 *   decisionPending?: boolean;
 * }} PeerEntry
 */

/**
 * @typedef {{
 *   msg_id: string;
 *   peer: string;
 *   kind: string;
 *   summary: string;
 *   ts: number;
 *   pinned: boolean;
 * }} QueuedDecision
 */

/**
 * @typedef {{
 *   peers: PeerEntry[];
 *   focused: string | null;
 *   busRoot?: string;
 *   meshName?: string;
 *   autoShiftNotice?: string | null;
 *   decisionsQueue?: QueuedDecision[];
 * }} ChromeOpts
 */

const STATE_ICONS = {
  running: `${GREEN}●${RESET}`,
  spawning: `${YELLOW}○${RESET}`,
  exiting: `${YELLOW}↓${RESET}`,
  exited: `${DIM}✗${RESET}`,
  crashed: `${BOLD}${RED}✗${RESET}`,
  unknown: `${DIM}?${RESET}`,
};

/**
 * Format a relative age string from a timestamp.
 *
 * @param {number} ts - epoch ms
 * @param {number} now - current epoch ms
 * @returns {string} e.g. "2m ago", "just now"
 */
function formatAge(ts, now) {
  const diffMs = now - ts;
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  return `${Math.floor(diffMs / 3_600_000)}h ago`;
}

/**
 * Render the decisions queue panel (under the peer list).
 * Shows each pinned item with peer name, kind, short summary, and age.
 * Count badge appears in the section header whenever the queue is non-empty.
 *
 * @param {QueuedDecision[]} items
 * @param {number} now - current epoch ms for age formatting
 * @returns {string[]} array of lines (no trailing newline per line)
 */
export function renderDecisionsPanel(items, now = Date.now()) {
  const lines = [];
  const count = items.length;
  const badge = count > 0 ? ` ${YELLOW}${BOLD}[${count}]${RESET}` : "";
  lines.push(`${BOLD}${CYAN}Decisions${RESET}${badge}`);

  if (count === 0) {
    lines.push(`${DIM}(none)${RESET}`);
  } else {
    for (const item of items) {
      const age = formatAge(item.ts, now);
      const pinIcon = item.pinned ? `${YELLOW}★${RESET} ` : "  ";
      const kindShort = item.kind.replace("approval-request", "approve").replace("submission", "submit");
      const summaryTrunc = item.summary.length > 30 ? `${item.summary.slice(0, 28)}…` : item.summary;
      lines.push(
        `${pinIcon}${BOLD}${WHITE}${item.peer}${RESET} ${DIM}${kindShort}${RESET} ${summaryTrunc} ${DIM}${age}${RESET}`,
      );
    }
  }

  return lines;
}

// DECSC (save cursor) / DECRC (restore cursor) — VT100 private sequences.
// Written as ESC 7 / ESC 8 (not CSI), so they work even when the terminal
// is in application-cursor mode.
const DECSC = "\x1b7";
const DECRC = "\x1b8";

/**
 * Render the right-rail chrome as a multi-line ANSI string.
 * Each line is terminated with `\n`.
 *
 * The output is wrapped in DECSC (\x1b7) / DECRC (\x1b8) so that chrome
 * renders cannot strand the focused peer's stdout cursor: the cursor is
 * saved before any chrome escapes and restored immediately after.
 *
 * @param {ChromeOpts} opts
 * @returns {string}
 */
export function renderChrome(opts) {
  const { peers, focused, busRoot, meshName, autoShiftNotice, decisionsQueue } = opts;
  const lines = [];

  // Header — include decisions count badge when queue is non-empty.
  const title = meshName ? `Mesh: ${meshName}` : "Mesh";
  const queueCount = decisionsQueue ? decisionsQueue.length : 0;
  const headerBadge = queueCount > 0 ? ` ${YELLOW}${BOLD}[${queueCount}]${RESET}` : "";
  lines.push(`${BOLD}${CYAN}${title}${RESET}${headerBadge}`);

  if (busRoot) {
    const short = busRoot.length > 30 ? `…${busRoot.slice(-28)}` : busRoot;
    lines.push(`${DIM}bus: ${short}${RESET}`);
  }

  const peerCount = peers.length;
  lines.push(`${DIM}${peerCount} peer${peerCount !== 1 ? "s" : ""}${RESET}`);
  lines.push(""); // blank separator

  // Peer rows
  for (const peer of peers) {
    lines.push(renderPeerRow(peer, peer.name === focused));
  }

  // Decisions queue panel (under the peers list).
  if (decisionsQueue !== undefined) {
    lines.push(""); // blank separator
    const panelLines = renderDecisionsPanel(decisionsQueue);
    lines.push(...panelLines);
  }

  // Auto-shift notice (persists until next focus change or user input).
  if (autoShiftNotice) {
    lines.push(""); // blank separator before notice
    lines.push(`${YELLOW}${BOLD}!${RESET} ${DIM}${autoShiftNotice}${RESET}`);
  }

  return DECSC + lines.join("\n") + "\n" + DECRC;
}

/**
 * Render a single peer row without surrounding chrome.
 * Useful for partial updates.
 *
 * Crashed peers show their exit code/signal next to the name.
 * Non-focused peers with a pending decision show a "decisions pending" badge.
 *
 * @param {PeerEntry} peer
 * @param {boolean} isFocused
 * @returns {string}
 */
export function renderPeerRow(peer, isFocused) {
  const icon = STATE_ICONS[peer.state] ?? STATE_ICONS.unknown;
  const focusMark = isFocused ? `${BOLD}${CYAN}▶${RESET} ` : "  ";

  let namePart;
  if (peer.state === "crashed") {
    // Show exit code or signal for crashed peers.
    const codeStr =
      peer.exitSignal
        ? `SIG${peer.exitSignal}`
        : peer.exitCode != null
        ? `exit=${peer.exitCode}`
        : "crashed";
    namePart = isFocused
      ? `${BOLD}${WHITE}${peer.name}${RESET} ${RED}(${codeStr})${RESET}`
      : `${DIM}${peer.name}${RESET} ${RED}(${codeStr})${RESET}`;
  } else {
    namePart = isFocused
      ? `${BOLD}${WHITE}${peer.name}${RESET}`
      : `${DIM}${peer.name}${RESET}`;
  }

  // Show "decisions pending" badge for non-focused peers with an open dialog.
  // Focused peers show the dialog itself, so no badge needed.
  const badge =
    !isFocused && peer.decisionPending
      ? ` ${YELLOW}${BOLD}[decisions pending]${RESET}`
      : "";

  return `${focusMark}${icon} ${namePart}${badge}`;
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
