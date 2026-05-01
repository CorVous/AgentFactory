/**
 * chrome.mjs — right-rail ANSI rendering for the multi-peer launcher.
 *
 * Renders a vertical strip showing:
 *   - Mesh metadata header (bus_root, node count).
 *   - Per-peer row: state icon + focus indicator + peer name.
 *
 * Output is plain ANSI text, no third-party TUI library required. The
 * rendering is deterministic for fixed input, making it straightforward
 * to test.
 *
 * State icons:
 *   ● running (green)
 *   ○ spawning (yellow)
 *   ✗ exited  (red/dim)
 *   ? unknown (dim)
 *
 * The focused peer's row is rendered with a bold accent color; others are dim.
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
 * @typedef {"spawning" | "running" | "exiting" | "exited" | "unknown"} PeerState
 */

/**
 * @typedef {{
 *   name: string;
 *   state: PeerState;
 * }} PeerEntry
 */

/**
 * @typedef {{
 *   peers: PeerEntry[];
 *   focused: string | null;
 *   busRoot?: string;
 *   meshName?: string;
 * }} ChromeOpts
 */

const STATE_ICONS = {
  running: `${GREEN}●${RESET}`,
  spawning: `${YELLOW}○${RESET}`,
  exiting: `${YELLOW}↓${RESET}`,
  exited: `${DIM}✗${RESET}`,
  unknown: `${DIM}?${RESET}`,
};

/**
 * Render the right-rail chrome as a multi-line ANSI string.
 * Each line is terminated with `\n`.
 *
 * @param {ChromeOpts} opts
 * @returns {string}
 */
export function renderChrome(opts) {
  const { peers, focused, busRoot, meshName } = opts;
  const lines = [];

  // Header
  const title = meshName ? `Mesh: ${meshName}` : "Mesh";
  lines.push(`${BOLD}${CYAN}${title}${RESET}`);

  if (busRoot) {
    const short = busRoot.length > 30 ? `…${busRoot.slice(-28)}` : busRoot;
    lines.push(`${DIM}bus: ${short}${RESET}`);
  }

  const peerCount = peers.length;
  lines.push(`${DIM}${peerCount} peer${peerCount !== 1 ? "s" : ""}${RESET}`);
  lines.push(""); // blank separator

  // Peer rows
  for (const peer of peers) {
    const icon = STATE_ICONS[peer.state] ?? STATE_ICONS.unknown;
    const isFocused = peer.name === focused;
    const focusMark = isFocused ? `${BOLD}${CYAN}▶${RESET} ` : "  ";
    const nameStr = isFocused
      ? `${BOLD}${WHITE}${peer.name}${RESET}`
      : `${DIM}${peer.name}${RESET}`;
    lines.push(`${focusMark}${icon} ${nameStr}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Render a single peer row without surrounding chrome.
 * Useful for partial updates.
 *
 * @param {PeerEntry} peer
 * @param {boolean} isFocused
 * @returns {string}
 */
export function renderPeerRow(peer, isFocused) {
  const icon = STATE_ICONS[peer.state] ?? STATE_ICONS.unknown;
  const focusMark = isFocused ? `${BOLD}${CYAN}▶${RESET} ` : "  ";
  const nameStr = isFocused
    ? `${BOLD}${WHITE}${peer.name}${RESET}`
    : `${DIM}${peer.name}${RESET}`;
  return `${focusMark}${icon} ${nameStr}`;
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
