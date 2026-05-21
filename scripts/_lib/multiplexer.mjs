/**
 * multiplexer.mjs — owns the launcher's terminal output + per-peer focus state.
 *
 * For slice 2 there is only one peer, but the API is designed so slice 3 can
 * add focus switching without rewriting:
 *
 *   - setFocus(name): declare which peer's buffer is painted to stdout.
 *   - getFocus(): returns the currently focused peer name.
 *   - paint(): render the focused buffer to the launcher's terminal immediately.
 *   - attachPool(pool): subscribe to output events from the PtyPool so the
 *     multiplexer redraws the focused peer's buffer on every PTY data chunk.
 *   - attachResizeHandler(): install a SIGWINCH handler that resizes all PTYs
 *     and repaints the focused buffer.
 *
 * The multiplexer writes raw ANSI to process.stdout. In a real launcher the
 * caller first puts the terminal in raw mode (e.g. via readline's raw mode or
 * process.stdin.setRawMode) so the ANSI sequences are interpreted correctly.
 *
 * Integration / manual tmux check:
 *   See docs/agents.md § "Verifying the multi-agent rails under tmux" for the
 *   tmux commands that verify rendering fidelity and clean teardown.
 *
 * TODO(manual-tmux-check): after wiring into launch-mesh.mjs,
 *   run the following to verify agent-header and agent-footer render correctly:
 *
 *   set -a; source models.env; set +a
 *   tmux new-session -d -s mux-test -x 220 -y 50 \
 *     'pi --recipe deferred-writer'
 *   sleep 5
 *   tmux capture-pane -t mux-test -p
 *   # expect agent-header, agent-footer in the pane output
 *   tmux send-keys -t mux-test 'Ctrl-C'
 *   # expect clean exit (ps aux | grep pi — no orphan processes)
 */

import { EventEmitter } from "node:events";

/**
 * Multiplexer — renders one virtual buffer to the launcher's terminal.
 *
 * @example
 *   const mux = createMultiplexer({ out: process.stdout });
 *   mux.attachPool(pool);
 *   mux.setFocus("peer-a");
 *   mux.attachResizeHandler(pool);
 */
export class Multiplexer extends EventEmitter {
  /**
   * @param {{
   *   out?: NodeJS.WritableStream;
   *   getTermSize?: () => {cols: number; rows: number};
   * }} [opts]
   */
  constructor(opts = {}) {
    super();
    /** @type {NodeJS.WritableStream} */
    this._out = opts.out ?? process.stdout;
    /** @type {(() => {cols: number; rows: number}) | undefined} */
    this._getTermSize = opts.getTermSize;
    /** @type {string | null} */
    this._focused = null;
    /** @type {import('./pty-pool.mjs').PtyPool | null} */
    this._pool = null;
    /** @type {(() => void) | null} internal cleanup for pool listener */
    this._poolOutputListener = null;
    /** @type {(() => void) | null} internal cleanup for SIGWINCH */
    this._sigwinchHandler = null;
  }

  /**
   * Attach a PtyPool. The multiplexer will subscribe to "output" events
   * from the pool and repaint the focused buffer whenever the focused peer
   * emits data.
   *
   * @param {import('./pty-pool.mjs').PtyPool} pool
   */
  attachPool(pool) {
    if (this._poolOutputListener) {
      this._pool?.off("output", this._poolOutputListener);
    }
    this._pool = pool;
    this._poolOutputListener = (name, data) => {
      if (name === this._focused) {
        // Pass-through: write raw PTY chunks directly to output without a
        // full repaint.  The buffer still accumulates the data (the pool's
        // VirtualBuffer.write() is called by the pool itself); we just
        // forward the bytes so the focused peer's TUI renders without
        // per-keystroke flicker or full-screen reprint.
        if (data !== undefined) {
          this._out.write(data);
        }
      }
    };
    pool.on("output", this._poolOutputListener);
  }

  /**
   * Set the focused peer. On next paint, this peer's buffer will be rendered.
   * Immediately repaints if a pool is attached.
   *
   * @param {string | null} name — peer name, or null to clear focus.
   */
  setFocus(name) {
    const prev = this._focused;
    this._focused = name;
    if (name !== prev) {
      // Focus change: hard-reset terminal state before repainting so scroll
      // regions, SGR attrs, and alt-screen content from the previously-focused
      // peer don't ghost behind the new peer's snapshot.
      this._repaint({ hardReset: true });
      // Schedule a follow-up paint after the new peer's xterm parser has
      // drained pending writes — otherwise PTY chunks that arrived just
      // before the switch are still being parsed when paint() ran above,
      // leaving the snapshot stale until the next chunk arrives.
      void this._followupPaintAfterDrain(name);
      this.emit("focus-changed", name);
    }
  }

  /**
   * Re-paint the focused peer once xterm has finished parsing any in-flight
   * writes. No-op if focus changed again before the drain resolved.
   *
   * @param {string} expectedFocus
   * @returns {Promise<void>}
   */
  async _followupPaintAfterDrain(expectedFocus) {
    if (!this._pool) return;
    const vb = this._pool.getBuffer(expectedFocus);
    if (!vb || typeof vb.drain !== "function") return;
    await vb.drain();
    // Bail if the user switched focus again while we were waiting.
    if (this._focused !== expectedFocus) return;
    if (typeof vb.invalidate === "function") vb.invalidate();
    const ansi = vb.paint();
    this._out.write(ansi);
  }

  /**
   * Get the currently focused peer name.
   *
   * @returns {string | null}
   */
  getFocus() {
    return this._focused;
  }

  /**
   * Paint the focused peer's buffer to the output stream.
   * No-op if no peer is focused or no pool is attached.
   */
  paint() {
    this._repaint();
  }

  /**
   * Install a SIGWINCH handler. On resize, resizes all peers in the pool
   * to the new terminal dimensions and repaints the focused buffer.
   *
   * @param {import('./pty-pool.mjs').PtyPool} pool — pool to resize on SIGWINCH
   */
  attachResizeHandler(pool) {
    if (this._sigwinchHandler) {
      process.off("SIGWINCH", this._sigwinchHandler);
    }
    this._sigwinchHandler = () => {
      const { cols, rows } = this._termSize();
      pool.resizeAll(cols, rows);
      this._repaint();
    };
    process.on("SIGWINCH", this._sigwinchHandler);
  }

  /**
   * Remove all installed event listeners (SIGWINCH, pool output).
   */
  detach() {
    if (this._poolOutputListener && this._pool) {
      this._pool.off("output", this._poolOutputListener);
      this._poolOutputListener = null;
    }
    if (this._sigwinchHandler) {
      process.off("SIGWINCH", this._sigwinchHandler);
      this._sigwinchHandler = null;
    }
  }

  // ── private ─────────────────────────────────────────────────────────────────

  /**
   * @param {{ hardReset?: boolean }} [opts]
   */
  _repaint(opts = {}) {
    if (!this._focused || !this._pool) return;
    const vb = this._pool.getBuffer(this._focused);
    if (!vb) return;
    if (opts.hardReset) {
      // DECSTR (soft terminal reset) + erase scrollback + erase screen + home.
      // Forces the terminal back to a known state before paint() writes the
      // new peer's snapshot, so SGR / scroll-region / alt-screen residue from
      // the previously-focused peer doesn't ghost through.
      this._out.write("\x1b[!p\x1b[3J\x1b[2J\x1b[H");
      // Invalidate the virtual buffer's cached paint so paint() re-renders
      // from xterm-headless's current state instead of returning a stale
      // snapshot that was generated before recent PTY chunks were parsed.
      if (typeof vb.invalidate === "function") vb.invalidate();
    }
    const ansi = vb.paint();
    this._out.write(ansi);
  }

  /**
   * Returns the current terminal size.
   *
   * @returns {{ cols: number; rows: number }}
   */
  _termSize() {
    if (this._getTermSize) return this._getTermSize();
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    return { cols, rows };
  }
}

/**
 * Factory function.
 *
 * @param {{
 *   out?: NodeJS.WritableStream;
 *   getTermSize?: () => {cols: number; rows: number};
 * }} [opts]
 * @returns {Multiplexer}
 */
export function createMultiplexer(opts = {}) {
  return new Multiplexer(opts);
}
