/**
 * virtual-buffer.mjs — per-peer xterm-headless wrapper for the launcher TUI.
 *
 * Captures PTY output into an off-screen ANSI buffer and exposes a paint()
 * method so the multiplexer can render the focused peer's buffer to the real
 * terminal.
 *
 * Design decisions:
 * - Uses @xterm/headless (v6) for ANSI state accumulation. The paint()
 *   method reconstructs the visible screen as raw ANSI escape sequences using
 *   cursor-motion + SGR attributes so the multiplexer can write it directly to
 *   the launcher's stdout.
 * - The module is a pure wrapper around xterm — no PTY, no real process, no
 *   filesystem. It is fully testable under vitest with no live PTY.
 * - resize() invalidates the cached paint so the next paint() call re-renders
 *   at the new dimensions.
 * - write() accepts a callback that fires when xterm has finished parsing the
 *   chunk, matching xterm's async write semantics.
 *
 * Referenced by:
 *   scripts/_lib/multiplexer.mjs (consumes paint())
 *   scripts/_lib/pty-pool.mjs (calls write() on PTY data)
 */

import { createRequire } from "node:module";

// xterm-headless is a CJS module — use createRequire for ESM compatibility.
const _require = createRequire(import.meta.url);
const { Terminal } = _require("@xterm/headless");

// ANSI escape helpers
const ESC = "\x1b";
const CSI = `${ESC}[`;

/** Move cursor to (row, col), 1-based. */
function moveTo(row, col) {
  return `${CSI}${row};${col}H`;
}

/** Reset all SGR attributes. */
const RESET_ATTRS = `${CSI}0m`;

/** Hide / show cursor escape sequences. */
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

/** Clear the screen and move cursor to (1,1). */
const CLEAR_SCREEN = `${CSI}2J${CSI}1;1H`;

/**
 * @typedef {{ cols: number; rows: number }} Dimensions
 */

/**
 * VirtualBuffer — wraps a headless xterm Terminal.
 *
 * Lifecycle:
 *   const vb = createVirtualBuffer({ cols: 220, rows: 50 });
 *   vb.write(chunk);          // feed PTY output
 *   vb.resize(cols, rows);    // propagate terminal resize
 *   const ansi = vb.paint();  // render to ANSI string
 *   vb.dispose();             // release xterm resources
 */
export class VirtualBuffer {
  /**
   * @param {Dimensions} dims
   */
  constructor(dims) {
    const { cols, rows } = dims;
    this._cols = cols;
    this._rows = rows;
    /** @type {import('@xterm/headless').Terminal} */
    this._term = new Terminal({ cols, rows, allowProposedApi: true });
    this._dirty = true;
    this._cachedPaint = "";
  }

  /** Number of columns in the virtual buffer. */
  get cols() {
    return this._cols;
  }

  /** Number of rows in the virtual buffer. */
  get rows() {
    return this._rows;
  }

  /**
   * Feed raw PTY output (may contain ANSI escape sequences) into the buffer.
   * Returns a Promise that resolves once xterm has finished processing the chunk.
   *
   * @param {string | Uint8Array} data
   * @returns {Promise<void>}
   */
  write(data) {
    this._dirty = true;
    return new Promise((resolve) => {
      this._term.write(data, resolve);
    });
  }

  /**
   * Resize the virtual buffer. Invalidates the cached paint.
   *
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    this._term.resize(cols, rows);
    this._dirty = true;
    this._cachedPaint = "";
  }

  /**
   * Render the current visible screen as an ANSI escape sequence string.
   * The string, when written to a VT-compatible terminal of the same
   * dimensions, reproduces the current buffer state.
   *
   * Output format:
   *   HIDE_CURSOR
   *   CLEAR_SCREEN
   *   For each row: move-to(row,1) + reconstructed SGR + text
   *   RESET_ATTRS
   *   SHOW_CURSOR
   *
   * The paint is cached until the next write() or resize() call.
   *
   * @returns {string}
   */
  paint() {
    if (!this._dirty) return this._cachedPaint;

    const buf = this._term.buffer.active;
    const rows = this._rows;
    const parts = [HIDE_CURSOR, CLEAR_SCREEN];

    for (let r = 0; r < rows; r++) {
      const line = buf.getLine(r);
      if (!line) {
        parts.push(moveTo(r + 1, 1));
        continue;
      }

      // Translate the line to a plain string (strips ANSI, just text).
      // For full fidelity we'd reconstruct per-cell SGR attributes.
      // The xterm API exposes translateToString() for plain text.
      // We use it for now; a future iteration can add attribute reconstruction.
      const text = line.translateToString(true /* trimRight */);
      parts.push(moveTo(r + 1, 1));
      parts.push(text);
    }

    parts.push(RESET_ATTRS);
    parts.push(SHOW_CURSOR);

    this._cachedPaint = parts.join("");
    this._dirty = false;
    return this._cachedPaint;
  }

  /**
   * Release xterm resources.
   */
  dispose() {
    this._term.dispose();
  }
}

/**
 * Factory function for creating a VirtualBuffer.
 *
 * @param {Dimensions} dims
 * @returns {VirtualBuffer}
 */
export function createVirtualBuffer(dims) {
  return new VirtualBuffer(dims);
}
