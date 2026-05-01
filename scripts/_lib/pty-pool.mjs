/**
 * pty-pool.mjs — spawns and manages peer PTYs for the launcher TUI.
 *
 * Each peer launched by `launch-mesh.mjs` or `run-agent.mjs` gets a PTY
 * spawned via `node-pty`. This module owns the PTY lifecycle:
 *
 *   - spawn: create the PTY, wire stdout to a VirtualBuffer.
 *   - resize: propagate terminal dimensions to the PTY.
 *   - kill: send SIGTERM, then SIGKILL after a grace period.
 *   - exit: emit an event when the PTY process exits.
 *
 * The module exposes a PtyPool class that manages a set of named peers.
 * The multiplexer subscribes to output events from the focused peer and
 * calls pool.resize() on SIGWINCH.
 *
 * Unit tests cover the lifecycle state machine without a real PTY by
 * injecting a mock spawn function (see pty-pool.test.ts).
 *
 * Integration / manual tmux check:
 *   See docs/agents.md § "Verifying the multi-agent rails under tmux".
 *   The tmux commands there verify that the full pi TUI renders correctly
 *   (agent-header, agent-footer, deferred-confirm) and that Ctrl-C / /quit
 *   tear down the peer cleanly.
 *
 * TODO(manual-tmux-check): run the following to verify PTY rendering fidelity:
 *   set -a; source models.env; set +a
 *   tmux new-session -d -s launcher-test -x 220 -y 50 \
 *     'npm run agent -- deferred-writer'
 *   sleep 5
 *   tmux capture-pane -t launcher-test -p
 *   # expect agent-header and agent-footer to render
 *   tmux send-keys -t launcher-test '/quit' Enter
 *   # expect clean exit, no orphan processes
 */

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { createVirtualBuffer } from "../../pi-sandbox/.pi/extensions/_lib/virtual-buffer.mjs";

const _require = createRequire(import.meta.url);

/**
 * @typedef {{
 *   name: string;
 *   state: "spawning" | "running" | "exiting" | "exited";
 *   exitCode: number | null;
 *   exitSignal: string | null;
 * }} PeerStatus
 */

/**
 * @typedef {{
 *   name: string;
 *   cmd: string;
 *   args: string[];
 *   cols: number;
 *   rows: number;
 *   cwd?: string;
 *   env?: Record<string, string>;
 * }} SpawnOptions
 */

// Grace period before SIGKILL after SIGTERM (ms).
const SIGKILL_GRACE_MS = 3000;

/**
 * @typedef {{
 *   peer: string;
 *   exitCode: number | null;
 *   signal: string | null;
 * }} CrashEvent
 */

/**
 * PtyPool — manages a set of named PTY processes.
 *
 * Events:
 *   "output"  (name: string, data: string) — PTY stdout data for a peer.
 *   "exit"    (name: string, code: number|null, signal: string|null) — peer exited.
 *   "crash"   (CrashEvent) — typed crash event: peer exited with non-zero code or signal.
 *   "error"   (name: string, err: Error) — PTY spawn error.
 */
export class PtyPool extends EventEmitter {
  /**
   * @param {{ spawnFn?: Function }} [opts]
   * spawnFn: injectable PTY spawn function for testing. Defaults to node-pty's spawn.
   */
  constructor(opts = {}) {
    super();
    /** @type {Map<string, {pty: any, vb: import('../../pi-sandbox/.pi/extensions/_lib/virtual-buffer.mjs').VirtualBuffer, status: PeerStatus}>} */
    this._peers = new Map();
    /** @type {Function} */
    this._spawnFn = opts.spawnFn ?? this._defaultSpawnFn();
  }

  /**
   * Load node-pty lazily so test code that never calls spawn() doesn't require
   * a real PTY environment.
   * @returns {Function}
   */
  _defaultSpawnFn() {
    let pty;
    return (cmd, args, opts) => {
      if (!pty) pty = _require("node-pty");
      return pty.spawn(cmd, args, opts);
    };
  }

  /**
   * Spawn a new PTY for a named peer.
   *
   * @param {SpawnOptions} opts
   * @returns {import('../../pi-sandbox/.pi/extensions/_lib/virtual-buffer.mjs').VirtualBuffer} the virtual buffer for this peer
   */
  spawn(opts) {
    const { name, cmd, args, cols, rows, cwd, env } = opts;
    if (this._peers.has(name)) {
      throw new Error(`pty-pool: peer '${name}' already spawned`);
    }

    /** @type {PeerStatus} */
    const status = {
      name,
      state: "spawning",
      exitCode: null,
      exitSignal: null,
    };

    const vb = createVirtualBuffer({ cols, rows });

    let ptyProcess;
    try {
      ptyProcess = this._spawnFn(cmd, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: cwd ?? process.cwd(),
        env: env ?? process.env,
      });
    } catch (err) {
      vb.dispose();
      this.emit("error", name, err);
      throw err;
    }

    status.state = "running";

    ptyProcess.onData((data) => {
      // Feed PTY output into the virtual buffer asynchronously.
      vb.write(data).catch(() => { /* ignore write errors on disposed buffer */ });
      this.emit("output", name, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      status.state = "exited";
      // Normalize: empty string signal → null (node-pty may send "" for no signal).
      const code = exitCode ?? null;
      const sig = (signal != null && signal !== "") ? signal : null;
      status.exitCode = code;
      status.exitSignal = sig;
      this.emit("exit", name, code, sig);
      // Emit a typed crash event when the process exits abnormally
      // (non-zero exit code, or killed by a non-empty signal).
      const isCrash = (code !== null && code !== 0) || sig !== null;
      if (isCrash) {
        /** @type {CrashEvent} */
        const crashEvent = { peer: name, exitCode: code, signal: sig };
        this.emit("crash", crashEvent);
      }
    });

    this._peers.set(name, { pty: ptyProcess, vb, status });
    return vb;
  }

  /**
   * Resize a peer's PTY to new dimensions. Also resizes its virtual buffer.
   *
   * @param {string} name
   * @param {number} cols
   * @param {number} rows
   */
  resize(name, cols, rows) {
    const peer = this._peers.get(name);
    if (!peer) return;
    if (peer.status.state !== "running") return;
    peer.vb.resize(cols, rows);
    try {
      peer.pty.resize(cols, rows);
    } catch { /* PTY may have exited between the check and the call */ }
  }

  /**
   * Resize ALL peers to new dimensions (e.g. after SIGWINCH on the launcher terminal).
   *
   * @param {number} cols
   * @param {number} rows
   */
  resizeAll(cols, rows) {
    for (const name of this._peers.keys()) {
      this.resize(name, cols, rows);
    }
  }

  /**
   * Write input to a peer's PTY stdin (e.g. user keystrokes injected by the multiplexer).
   *
   * @param {string} name
   * @param {string} data
   */
  write(name, data) {
    const peer = this._peers.get(name);
    if (!peer || peer.status.state !== "running") return;
    peer.pty.write(data);
  }

  /**
   * Kill a peer: send SIGTERM, then SIGKILL after the grace period.
   *
   * @param {string} name
   * @param {number} [gracePeriodMs]
   * @returns {Promise<void>} resolves when the peer exits or the kill completes
   */
  kill(name, gracePeriodMs = SIGKILL_GRACE_MS) {
    const peer = this._peers.get(name);
    if (!peer) return Promise.resolve();
    if (peer.status.state === "exited") return Promise.resolve();
    if (peer.status.state === "exiting") {
      // Already killing — wait for exit event.
      return new Promise((resolve) => {
        this.once("exit", (n) => { if (n === name) resolve(); });
      });
    }

    peer.status.state = "exiting";

    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        peer.vb.dispose();
        resolve();
      };

      this.once("exit", (n) => { if (n === name) cleanup(); });

      try { peer.pty.kill("SIGTERM"); } catch { /* already dead */ }

      const timer = setTimeout(() => {
        try { peer.pty.kill("SIGKILL"); } catch { /* already dead */ }
        // If the peer doesn't exit after SIGKILL, resolve anyway.
        setTimeout(resolve, 200);
      }, gracePeriodMs);
    });
  }

  /**
   * Kill all peers and resolve when all have exited.
   *
   * @param {number} [gracePeriodMs]
   * @returns {Promise<void>}
   */
  async killAll(gracePeriodMs = SIGKILL_GRACE_MS) {
    const names = [...this._peers.keys()];
    await Promise.all(names.map((n) => this.kill(n, gracePeriodMs)));
  }

  /**
   * Get the current status of a peer.
   *
   * @param {string} name
   * @returns {PeerStatus | undefined}
   */
  getStatus(name) {
    return this._peers.get(name)?.status;
  }

  /**
   * Get the VirtualBuffer for a peer.
   *
   * @param {string} name
   * @returns {import('../../pi-sandbox/.pi/extensions/_lib/virtual-buffer.mjs').VirtualBuffer | undefined}
   */
  getBuffer(name) {
    return this._peers.get(name)?.vb;
  }

  /**
   * List names of all known peers (including exited ones).
   *
   * @returns {string[]}
   */
  listPeers() {
    return [...this._peers.keys()];
  }
}

/**
 * Factory function.
 *
 * @param {{ spawnFn?: Function }} [opts]
 * @returns {PtyPool}
 */
export function createPtyPool(opts = {}) {
  return new PtyPool(opts);
}
