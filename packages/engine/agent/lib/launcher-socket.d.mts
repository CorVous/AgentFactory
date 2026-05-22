/**
 * launcher-socket.d.mts — TypeScript declarations for launcher-socket.mjs
 */

import { EventEmitter } from "node:events";
import type { LauncherEnvelope } from "./launcher-envelope.mjs";

export { LauncherEnvelope };

/** The socket filename stem used for the launcher control channel. */
export const LAUNCHER_SOCK_NAME: "__launcher__";

/**
 * LauncherSocket — the server side of the launcher control channel.
 *
 * Events:
 *   "envelope" (env: LauncherEnvelope) — a valid inbound envelope arrived.
 *   "client-connected" (id: string)    — a peer client connected.
 *   "client-disconnected" (id: string) — a peer client disconnected.
 *   "error" (err: Error)               — server error.
 */
export class LauncherSocket extends EventEmitter {
  constructor(opts?: LauncherSocketOptions);

  /**
   * Bind the server to `${busRoot}/__launcher__.sock`.
   * Resolves when the server is listening.
   * Rejects if the socket is already held by a live launcher.
   */
  bind(busRoot: string): Promise<void>;

  /**
   * Broadcast an envelope to all currently connected clients.
   */
  broadcast(env: LauncherEnvelope): void;

  /**
   * Returns the socket path this server is bound to, or null if not yet bound.
   */
  getSockPath(): string | null;

  /**
   * Returns the number of currently connected clients.
   */
  clientCount(): number;

  /**
   * Close the server and all client connections.
   */
  close(): Promise<void>;

  on(event: "envelope", listener: (env: LauncherEnvelope) => void): this;
  on(event: "client-connected", listener: (id: string) => void): this;
  on(event: "client-disconnected", listener: (id: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;

  emit(event: "envelope", env: LauncherEnvelope): boolean;
  emit(event: "client-connected", id: string): boolean;
  emit(event: "client-disconnected", id: string): boolean;
  emit(event: "error", err: Error): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

export interface LauncherSocketOptions {
  createServer?: import("node:net").Server extends never ? never : (...args: unknown[]) => import("node:net").Server;
}

/**
 * LauncherClient — the client side of the launcher control channel.
 *
 * Events:
 *   "envelope" (env: LauncherEnvelope) — an envelope arrived from the launcher.
 *   "connected" ()                      — connection established.
 *   "disconnected" ()                   — connection closed.
 *   "error" (err: Error)                — connection error.
 */
export class LauncherClient extends EventEmitter {
  constructor(opts?: LauncherClientOptions);

  /**
   * Connect to `${busRoot}/__launcher__.sock`.
   * Resolves on success; rejects if the socket is not found or times out.
   */
  connect(busRoot: string, timeoutMs?: number): Promise<void>;

  /**
   * Send an envelope to the launcher.
   * Returns true if the write was attempted, false if not connected.
   */
  send(env: LauncherEnvelope): boolean;

  /**
   * Whether the client is currently connected.
   */
  isConnected(): boolean;

  /**
   * Close the connection.
   */
  disconnect(): void;

  on(event: "envelope", listener: (env: LauncherEnvelope) => void): this;
  on(event: "connected", listener: () => void): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;

  emit(event: "envelope", env: LauncherEnvelope): boolean;
  emit(event: "connected"): boolean;
  emit(event: "disconnected"): boolean;
  emit(event: "error", err: Error): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

export interface LauncherClientOptions {
  connect?: (...args: unknown[]) => import("node:net").Socket;
}

/**
 * Factory — creates a new LauncherSocket (server) instance.
 */
export function createLauncherSocket(opts?: LauncherSocketOptions): LauncherSocket;

/**
 * Factory — creates a new LauncherClient instance.
 */
export function createLauncherClient(opts?: LauncherClientOptions): LauncherClient;
