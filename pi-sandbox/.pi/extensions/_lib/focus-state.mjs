/**
 * focus-state.mjs — in-peer focus state holder.
 *
 * Tracks whether this peer is the currently focused peer in the launcher's
 * multi-peer TUI. Updated by the `launcher-bridge` extension when it receives
 * `focus-changed` envelopes from the launcher socket.
 *
 * Design: pure in-process module, no I/O. The extension layer handles socket
 * communication; this module just holds the boolean and emits events.
 *
 * Events (EventEmitter):
 *   "focus-changed" ({ focused: boolean }) — emitted when focus state changes.
 */

import { EventEmitter } from "node:events";

/**
 * FocusState — single-peer focus tracking.
 *
 * @extends {EventEmitter}
 */
export class FocusState extends EventEmitter {
  /**
   * @param {{ initialFocused?: boolean }} [opts]
   */
  constructor(opts = {}) {
    super();
    /** @type {boolean} */
    this._focused = opts.initialFocused ?? false;
  }

  /**
   * Returns whether this peer is currently focused.
   *
   * @returns {boolean}
   */
  isFocused() {
    return this._focused;
  }

  /**
   * Update focus state based on a signal from the launcher.
   * Emits "focus-changed" only when the state actually changes.
   *
   * @param {boolean} focused
   */
  update(focused) {
    const prev = this._focused;
    this._focused = focused;
    if (focused !== prev) {
      this.emit("focus-changed", { focused });
    }
  }
}

/**
 * Factory function.
 *
 * @param {{ initialFocused?: boolean }} [opts]
 * @returns {FocusState}
 */
export function createFocusState(opts = {}) {
  return new FocusState(opts);
}
