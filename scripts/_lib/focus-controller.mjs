/**
 * focus-controller.mjs — manages focus state for the multi-peer launcher.
 *
 * Wraps the Multiplexer's setFocus/getFocus seam with:
 *   - Peer registration (setFocus on unknown peer is rejected).
 *   - No-op detection (setFocus to the current peer is silent).
 *   - focus-changed event emission to all registered subscribers.
 *   - Crash auto-shift: when the focused peer crashes, focus shifts to the
 *     top supervisor (via handleCrash). An auto-shift notice persists until
 *     the next focus change or user input.
 *
 * This is a pure in-process module with no I/O. The launcher socket
 * integration lives in launcher-socket.mjs which calls setFocus here.
 *
 * Events:
 *   "focus-changed" ({ focused: string | null, prev: string | null })
 *   "crash-notice"  (CrashNoticeEvent) — emitted by handleCrash for chrome rendering.
 */

import { EventEmitter } from "node:events";

/**
 * @typedef {{
 *   focused: string | null;
 *   prev: string | null;
 * }} FocusChangedEvent
 */

/**
 * @typedef {{
 *   peerName: string;
 *   shiftedTo: string | null;
 *   topSupervisor: string | null;
 *   wasTopSupervisor: boolean;
 * }} CrashNoticeEvent
 */

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
    /** @type {string | null} — persists until next focus change or user input */
    this._autoShiftNotice = null;
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
   * Get the current auto-shift notice (or null if none).
   *
   * @returns {string | null}
   */
  getAutoShiftNotice() {
    return this._autoShiftNotice;
  }

  /**
   * Clear the auto-shift notice (call on user input or manual focus change).
   */
  clearAutoShiftNotice() {
    this._autoShiftNotice = null;
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
    // Clear auto-shift notice on manual focus change.
    this._autoShiftNotice = null;
    this.emit("focus-changed", { focused: name, prev });
    return { ok: true };
  }

  /**
   * Handle a crash event from the pty-pool.
   *
   * Rules:
   *   - If the crashed peer is NOT the currently focused peer → no-op for focus;
   *     emits a crash-notice with wasTopSupervisor reflecting whether it was the top.
   *   - If the crashed peer IS the focused peer AND is the top supervisor →
   *     no focus shift; emits a crash-notice with wasTopSupervisor=true and sets a notice.
   *   - If the crashed peer IS the focused peer AND is NOT the top supervisor →
   *     auto-shifts focus to topSupervisor (if resolvable and registered);
   *     sets the auto-shift notice; emits crash-notice + focus-changed.
   *
   * @param {string} peerName — name of the crashed peer
   * @param {string | null} topSupervisor — top supervisor as resolved by crashAutoShiftTarget
   */
  handleCrash(peerName, topSupervisor) {
    const isTopSupervisor = peerName === topSupervisor;
    const isFocused = this._focused === peerName;

    if (!isFocused) {
      // Crash on a non-focused peer: no-op for focus, just emit notice.
      /** @type {CrashNoticeEvent} */
      const notice = { peerName, shiftedTo: null, topSupervisor, wasTopSupervisor: isTopSupervisor };
      this.emit("crash-notice", notice);
      return;
    }

    if (isTopSupervisor) {
      // The focused peer is the top supervisor itself — no shift, just a notice.
      this._autoShiftNotice = `top supervisor "${peerName}" exited; no peer to shift focus to`;
      /** @type {CrashNoticeEvent} */
      const notice = { peerName, shiftedTo: null, topSupervisor, wasTopSupervisor: true };
      this.emit("crash-notice", notice);
      return;
    }

    // Focused non-top-supervisor peer crashed → shift to top supervisor.
    let shiftedTo = null;
    if (topSupervisor !== null && this._peers.has(topSupervisor)) {
      shiftedTo = topSupervisor;
      const prev = this._focused;
      this._focused = topSupervisor;
      this._autoShiftNotice = `entry peer "${peerName}" exited; focus moved to "${topSupervisor}"`;
      this.emit("focus-changed", { focused: topSupervisor, prev });
    } else {
      // Top supervisor not registered (also crashed or never existed) — clear focus.
      const prev = this._focused;
      this._focused = null;
      this._autoShiftNotice = `entry peer "${peerName}" exited; no live supervisor to shift focus to`;
      this.emit("focus-changed", { focused: null, prev });
    }

    /** @type {CrashNoticeEvent} */
    const notice = { peerName, shiftedTo, topSupervisor, wasTopSupervisor: false };
    this.emit("crash-notice", notice);
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
