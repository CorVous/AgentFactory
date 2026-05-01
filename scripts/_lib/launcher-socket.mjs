/**
 * launcher-socket.mjs — Unix-socket server for the launcher control channel.
 *
 * The launcher binds `${BUS_ROOT}/__launcher__.sock`. Peers connect to this
 * socket to send control envelopes (e.g. `focus-request`) and receive
 * broadcast signals (e.g. `focus-changed`).
 *
 * Design:
 *   - One server, multiple persistent peer connections.
 *   - Inbound envelopes are parsed with tryDecodeEnvelope and dispatched to
 *     registered subscribers.
 *   - Outbound broadcasts write to all connected clients.
 *   - Version mismatches (v !== 1) are logged to stderr and dropped.
 *
 * Hermetic tests bind to a tmpdir socket within a single process.
 */

import net from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
import { encodeEnvelope, tryDecodeEnvelope } from "./launcher-envelope.mjs";

export const LAUNCHER_SOCK_NAME = "__launcher__";

/**
 * LauncherSocket — the server side of the launcher control channel.
 *
 * Events:
 *   "envelope" (env: LauncherEnvelope) — a valid inbound envelope arrived.
 *   "client-connected" (id: string)    — a peer client connected.
 *   "client-disconnected" (id: string) — a peer client disconnected.
 *   "error" (err: Error)               — server error.
 *
 * @extends {EventEmitter}
 */
export class LauncherSocket extends EventEmitter {
  /**
   * @param {{
   *   createServer?: typeof net.createServer;
   * }} [opts]
   */
  constructor(opts = {}) {
    super();
    /** @type {typeof net.createServer} */
    this._createServer = opts.createServer ?? net.createServer.bind(net);
    /** @type {net.Server | null} */
    this._server = null;
    /** @type {string | null} */
    this._sockPath = null;
    /** @type {Map<string, net.Socket>} */
    this._clients = new Map();
    /** @type {number} */
    this._nextClientId = 1;
  }

  /**
   * Bind the server to the launcher socket at `${busRoot}/__launcher__.sock`.
   *
   * @param {string} busRoot
   * @returns {Promise<void>} resolves when the server is listening.
   */
  bind(busRoot) {
    if (this._server) return Promise.resolve();
    const sockPath = path.join(busRoot, `${LAUNCHER_SOCK_NAME}.sock`);
    this._sockPath = sockPath;

    return new Promise((resolve, reject) => {
      const server = this._createServer((socket) => {
        const clientId = String(this._nextClientId++);
        this._clients.set(clientId, socket);
        this.emit("client-connected", clientId);

        let buf = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const { env, versionMismatch } = tryDecodeEnvelope(line);
            if (env) {
              this.emit("envelope", env);
            } else if (versionMismatch) {
              process.stderr.write(
                `launcher-socket: dropped envelope with wrong version: ${line.slice(0, 120)}\n`,
              );
            }
            // else: malformed JSON — silently drop
          }
        });

        socket.on("close", () => {
          this._clients.delete(clientId);
          this.emit("client-disconnected", clientId);
        });

        socket.on("error", () => {
          // Individual client errors don't kill the server.
          this._clients.delete(clientId);
        });
      });

      this._server = server;

      server.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });

      server.listen(sockPath, () => resolve());
    });
  }

  /**
   * Broadcast an envelope to all connected clients.
   *
   * @param {import('./launcher-envelope.mjs').LauncherEnvelope} env
   */
  broadcast(env) {
    const line = encodeEnvelope(env);
    for (const [, socket] of this._clients) {
      try {
        if (!socket.destroyed) socket.write(line, "utf8");
      } catch { /* client may have disconnected between check and write */ }
    }
  }

  /**
   * Returns the socket path this server is bound to, or null if not bound.
   *
   * @returns {string | null}
   */
  getSockPath() {
    return this._sockPath;
  }

  /**
   * Returns the number of currently connected clients.
   *
   * @returns {number}
   */
  clientCount() {
    return this._clients.size;
  }

  /**
   * Close the server and all client connections.
   *
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve) => {
      // Destroy all client sockets first.
      for (const [, socket] of this._clients) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      this._clients.clear();
      if (!this._server) {
        resolve();
        return;
      }
      this._server.close(() => resolve());
      this._server = null;
    });
  }
}

/**
 * Factory function.
 *
 * @param {{
 *   createServer?: typeof net.createServer;
 * }} [opts]
 * @returns {LauncherSocket}
 */
export function createLauncherSocket(opts = {}) {
  return new LauncherSocket(opts);
}

/**
 * LauncherClient — the client side of the launcher control channel (used by peers).
 *
 * Connects to the launcher socket, sends envelopes, and receives broadcasts.
 *
 * Events:
 *   "envelope" (env: LauncherEnvelope) — an envelope arrived from the launcher.
 *   "connected" ()                      — connection established.
 *   "disconnected" ()                   — connection closed.
 *   "error" (err: Error)                — connection error.
 *
 * @extends {EventEmitter}
 */
export class LauncherClient extends EventEmitter {
  /**
   * @param {{
   *   connect?: typeof net.connect;
   * }} [opts]
   */
  constructor(opts = {}) {
    super();
    /** @type {typeof net.connect} */
    this._connect = opts.connect ?? net.connect.bind(net);
    /** @type {net.Socket | null} */
    this._socket = null;
    /** @type {boolean} */
    this._connected = false;
  }

  /**
   * Connect to the launcher socket at `${busRoot}/__launcher__.sock`.
   * Resolves on success; rejects if the socket is not found (peer is standalone).
   *
   * @param {string} busRoot
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  connect(busRoot, timeoutMs = 2000) {
    const sockPath = path.join(busRoot, `${LAUNCHER_SOCK_NAME}.sock`);
    return new Promise((resolve, reject) => {
      const socket = this._connect(sockPath);
      this._socket = socket;

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`launcher-client: connect timeout to ${sockPath}`));
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        this._connected = true;
        socket.setEncoding("utf8");
        this.emit("connected");
        resolve();

        let buf = "";
        socket.on("data", (chunk) => {
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const { env, versionMismatch } = tryDecodeEnvelope(line);
            if (env) {
              this.emit("envelope", env);
            } else if (versionMismatch) {
              process.stderr.write(
                `launcher-client: dropped envelope with wrong version: ${line.slice(0, 120)}\n`,
              );
            }
          }
        });
      });

      socket.once("close", () => {
        clearTimeout(timer);
        this._connected = false;
        this.emit("disconnected");
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        this._connected = false;
        this._socket = null;
        // Emit only if there are listeners; otherwise reject silently.
        if (this.listenerCount("error") > 0) this.emit("error", err);
        reject(err);
      });
    });
  }

  /**
   * Send an envelope to the launcher.
   *
   * @param {import('./launcher-envelope.mjs').LauncherEnvelope} env
   * @returns {boolean} true if the write was attempted, false if not connected.
   */
  send(env) {
    if (!this._socket || !this._connected || this._socket.destroyed) return false;
    try {
      this._socket.write(encodeEnvelope(env), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the client is currently connected.
   *
   * @returns {boolean}
   */
  isConnected() {
    return this._connected;
  }

  /**
   * Close the connection.
   */
  disconnect() {
    if (this._socket) {
      try { this._socket.destroy(); } catch { /* ignore */ }
      this._socket = null;
      this._connected = false;
    }
  }
}

/**
 * Factory function.
 *
 * @param {{
 *   connect?: typeof net.connect;
 * }} [opts]
 * @returns {LauncherClient}
 */
export function createLauncherClient(opts = {}) {
  return new LauncherClient(opts);
}
