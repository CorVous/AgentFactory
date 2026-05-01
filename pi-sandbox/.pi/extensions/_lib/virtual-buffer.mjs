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

/**
 * Build an SGR escape string for the attributes of a cell.
 * Returns an empty string when all attributes are default.
 *
 * Emits: bold (1), italic (3), underline (4), foreground color, background color.
 * Colors: palette via 256-color syntax (38;5;n / 48;5;n), RGB via (38;2;r;g;b / 48;2;r;g;b).
 *
 * @param {import('@xterm/headless').IBufferCell} cell
 * @returns {string} SGR escape sequence or empty string
 */
function cellSgr(cell) {
  if (cell.isAttributeDefault()) return "";

  const codes = [];

  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);

  // Foreground
  if (!cell.isFgDefault()) {
    if (cell.isFgPalette()) {
      const n = cell.getFgColor();
      if (n < 8) {
        codes.push(30 + n);
      } else if (n < 16) {
        codes.push(90 + n - 8);
      } else {
        codes.push(38, 5, n);
      }
    } else if (cell.isFgRGB()) {
      const rgb = cell.getFgColor();
      const r = (rgb >> 16) & 0xff;
      const g = (rgb >> 8) & 0xff;
      const b = rgb & 0xff;
      codes.push(38, 2, r, g, b);
    }
  }

  // Background
  if (!cell.isBgDefault()) {
    if (cell.isBgPalette()) {
      const n = cell.getBgColor();
      if (n < 8) {
        codes.push(40 + n);
      } else if (n < 16) {
        codes.push(100 + n - 8);
      } else {
        codes.push(48, 5, n);
      }
    } else if (cell.isBgRGB()) {
      const rgb = cell.getBgColor();
      const r = (rgb >> 16) & 0xff;
      const g = (rgb >> 8) & 0xff;
      const b = rgb & 0xff;
      codes.push(48, 2, r, g, b);
    }
  }

  if (codes.length === 0) return "";
  return `${CSI}${codes.join(";")}m`;
}

/**
 * Returns true if two cells share the same display attributes (for run compression).
 *
 * @param {import('@xterm/headless').IBufferCell} a
 * @param {import('@xterm/headless').IBufferCell} b
 * @returns {boolean}
 */
function sameAttrs(a, b) {
  return (
    a.isAttributeDefault() === b.isAttributeDefault() &&
    a.getFgColorMode() === b.getFgColorMode() &&
    a.getFgColor() === b.getFgColor() &&
    a.getBgColorMode() === b.getBgColorMode() &&
    a.getBgColor() === b.getBgColor() &&
    a.isBold() === b.isBold() &&
    a.isDim() === b.isDim() &&
    a.isItalic() === b.isItalic() &&
    a.isUnderline() === b.isUnderline() &&
    a.isBlink() === b.isBlink() &&
    a.isInverse() === b.isInverse() &&
    a.isInvisible() === b.isInvisible() &&
    a.isStrikethrough() === b.isStrikethrough()
  );
}

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
    const cols = this._cols;
    const parts = [HIDE_CURSOR, CLEAR_SCREEN];

    // Reuse a single cell object to avoid repeated allocation.
    const nullCell = buf.getNullCell();
    const reuseCell = buf.getNullCell();

    for (let r = 0; r < rows; r++) {
      const line = buf.getLine(r);
      if (!line) {
        parts.push(moveTo(r + 1, 1));
        continue;
      }

      parts.push(moveTo(r + 1, 1));
      // Reset attributes at the start of each row so SGR runs are absolute.
      parts.push(RESET_ATTRS);

      // Walk cells and emit per-run SGR + text.
      // A "run" is a maximal sequence of cells sharing the same attributes.
      let runStart = 0;
      let runText = "";
      /** @type {import('@xterm/headless').IBufferCell | null} */
      let runCell = null;

      const flushRun = () => {
        if (runText.length === 0) return;
        if (runCell) {
          const sgr = cellSgr(runCell);
          if (sgr) parts.push(sgr);
        }
        parts.push(runText);
        runText = "";
        runCell = null;
      };

      for (let c = 0; c < cols; c++) {
        const cell = line.getCell(c, reuseCell);
        if (!cell) continue;

        // Skip continuation cells of wide characters (width 0 after wide).
        if (cell.getWidth() === 0) continue;

        if (runCell === null) {
          // Start a new run.
          runCell = buf.getNullCell();
          // Copy current cell's attributes into runCell by reading via the API.
          // We store runCell as a reference snapshot — we re-fetch per cell.
          // Actually we keep the first cell of the run as the attribute template.
          line.getCell(c, runCell);
          runText = cell.getChars() || " ";
        } else if (sameAttrs(runCell, cell)) {
          // Same attributes — extend the run.
          runText += cell.getChars() || " ";
        } else {
          // Attributes changed — flush current run, start new one.
          flushRun();
          runCell = buf.getNullCell();
          line.getCell(c, runCell);
          runText = cell.getChars() || " ";
        }
      }
      flushRun();

      // Reset at end of row.
      parts.push(RESET_ATTRS);
    }

    // Emit cursor position derived from xterm's tracked cursor state.
    // cursorX/Y are 0-based; CUP (CSI row;colH) is 1-based.
    const cursorRow = buf.cursorY + 1;
    const cursorCol = buf.cursorX + 1;
    parts.push(moveTo(cursorRow, cursorCol));

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
