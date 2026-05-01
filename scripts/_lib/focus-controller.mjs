/**
 * focus-controller.mjs — manages focus state for the multi-peer launcher.
 *
 * Wraps the Multiplexer's setFocus/getFocus seam with:
 *   - Peer registration (setFocus on unknown peer is rejected).
 *   - No-op detection (setFocus to the current peer is silent).
 *   - focus-changed event emission to all registered subscribers.
 *
 * This is a pure in-process module with no I/O. The launcher socket
 * integration lives in launcher-socket.mjs which calls setFocus here.
 *
 * Events:
 *   "focus-changed" ({ focused: string | null, prev: string | null })
 */

import { EventEmitter } from "node:events";

/**
 * FocusController — tracks which peer has focus and notifies subscribers.
 *
 * @extends {EventEmitter}
 */
export class FocusController extends EventEmitter {
  constructor() {
    super();
    /** @type {Set<string>} */
    this._peers = new Set();
    /** @type {string | null} */
    this._focused = null;
  }

  /**
   * Register a peer so it can be focused. Must be called before setFocus.
   *
   * @param {string} name
   */
  registerPeer(name) {
    this._peers.add(name);
  }

  /**
   * Unregister a peer. If it is currently focused, focus is cleared.
   *
   * @param {string} name
   */
  unregisterPeer(name) {
    this._peers.delete(name);
    if (this._focused === name) {
      const prev = this._focused;
      this._focused = null;
      this.emit("focus-changed", { focused: null, prev });
    }
  }

  /**
   * Returns the names of all registered peers.
   *
   * @returns {string[]}
   */
  listPeers() {
    return [...this._peers];
  }

  /**
   * Get the name of the currently focused peer.
   *
   * @returns {string | null}
   */
  getFocus() {
    return this._focused;
  }

  /**
   * Set focus to the named peer.
   *
   * @param {string | null} name — peer name, or null to clear focus.
   * @returns {{ ok: true } | { ok: false; reason: string }}
   */
  setFocus(name) {
    if (name !== null && !this._peers.has(name)) {
      return { ok: false, reason: `unknown peer: ${name}` };
    }
    if (name === this._focused) {
      // No-op: target is already focused.
      return { ok: true };
    }
    const prev = this._focused;
    this._focused = name;
    this.emit("focus-changed", { focused: name, prev });
    return { ok: true };
  }
}

/**
 * Factory function.
 *
 * @returns {FocusController}
 */
export function createFocusController() {
  return new FocusController();
}
