// Shared low-level Unix-socket sender for peer-bus communications.
//
// Both peer-bus.ts's sendEnvelope and submission-emit.ts's makeBusSender
// open a socket to ${busRoot}/${toName}.sock, write one JSON line, and close.
// This module provides a single tested implementation so a future change
// (wire-format checksum, retry policy, etc.) has one home.
//
// Also defines the BusTransport interface and the default UnixSocketTransport
// implementation, so the mesh transport is swappable without modifying
// peer-bus.ts (the extension) directly.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface BusSendResult {
  delivered: boolean;
  reason?: string;
}

/** Send a single newline-terminated envelope line to a named peer.
 *
 * @param busRoot   Directory holding peer sockets (one per peer: `<name>.sock`).
 * @param toName    Peer name; socket path is `${busRoot}/${toName}.sock`.
 * @param envelopeLine  Raw wire line to send (typically `encodeEnvelope(env)`).
 * @param timeoutMs     Connection+write timeout in ms (default 1 000).
 */
export function sendOverBus(
  busRoot: string,
  toName: string,
  envelopeLine: string,
  timeoutMs = 1_000,
): Promise<BusSendResult> {
  const dest = path.join(busRoot, `${toName}.sock`);
  return new Promise<BusSendResult>((resolve) => {
    const sock = net.connect(dest);
    const done = (r: BusSendResult) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ delivered: false, reason: "timeout" }), timeoutMs);
    sock.once("connect", () => {
      sock.write(envelopeLine, "utf8", () => {
        clearTimeout(timer);
        done({ delivered: true });
      });
    });
    sock.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const reason =
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? "peer offline"
          : `socket error: ${e.message}`;
      done({ delivered: false, reason });
    });
  });
}

// ---------------------------------------------------------------------------
// BusTransport interface + UnixSocketTransport default implementation
// ---------------------------------------------------------------------------

/** Callback invoked by the transport for every raw newline-framed line received. */
export type LineHandler = (line: string) => void;

/** A discovered peer on the bus. */
export interface BusPeer {
  name: string;
  addr: string;
}

/**
 * Abstraction over the peer-bus transport layer. All Unix-socket I/O
 * (bind/listen, send, discover, close) goes through this interface so a
 * future transport (e.g. a message broker) can replace the default
 * implementation without touching the extension.
 *
 * Wire-format invariant: the transport is line-oriented (newline-framed JSON).
 * It does NOT decode envelopes — that responsibility stays in peer-bus.ts.
 */
export interface BusTransport {
  /**
   * Send a single newline-terminated line to a named peer.
   * Fire-and-forget: always resolves a BusSendResult, never rejects.
   */
  send(toName: string, line: string, timeoutMs?: number): Promise<BusSendResult>;

  /**
   * Bind to the given name on the bus and start receiving lines.
   * Calls onLine for each complete newline-framed line received.
   * Throws (with message `peer-bus name collision: ${name}`) if the name is
   * already held by a live peer; callers should surface this as a UI error.
   * Reclaims a stale socket (EADDRINUSE + not-live) transparently.
   */
  listen(selfName: string, onLine: LineHandler): Promise<void>;

  /**
   * Discover live peers on the bus. Self is always included (unprobed).
   * Stale sockets for other names are probed and unlinked when dead.
   */
  discover(selfName: string): Promise<BusPeer[]>;

  /**
   * Probe whether a named peer's socket is currently live.
   */
  isLive(name: string): Promise<boolean>;

  /** Async close: close the server and remove the bound socket file. */
  close(): Promise<void>;

  /**
   * Synchronous close for process.once("exit") handlers.
   * Node ignores pending async work at exit, so this must be synchronous.
   */
  closeSync(): void;
}

// ---------------------------------------------------------------------------
// UnixSocketTransport — the default Unix-domain-socket implementation
// ---------------------------------------------------------------------------

class UnixSocketTransport implements BusTransport {
  private readonly busRoot: string;
  private server: net.Server | undefined;
  private boundSockPath: string | undefined;

  constructor(busRoot: string) {
    this.busRoot = busRoot;
  }

  send(toName: string, line: string, timeoutMs?: number): Promise<BusSendResult> {
    // Delegate to the existing tested sendOverBus implementation.
    const result = sendOverBus(this.busRoot, toName, line, timeoutMs);

    // Opportunistic cleanup: if the peer's socket was left by a crashed
    // process, unlink it so isLive and discover return an accurate picture.
    return result.then((r) => {
      if (!r.delivered && r.reason === "peer offline") {
        const dest = path.join(this.busRoot, `${toName}.sock`);
        try { fs.unlinkSync(dest); } catch { /* noop */ }
      }
      return r;
    });
  }

  listen(selfName: string, onLine: LineHandler): Promise<void> {
    const sockPath = path.join(this.busRoot, `${selfName}.sock`);
    fs.mkdirSync(this.busRoot, { recursive: true });

    const server = net.createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          onLine(line);
        }
      });
      conn.on("error", () => conn.destroy());
    });

    const tryListen = (): Promise<void> =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(sockPath, () => {
          server.removeAllListeners("error");
          resolve();
        });
      });

    return (async () => {
      try {
        await tryListen();
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "EADDRINUSE") throw e;
        const live = await this.isLive(selfName);
        if (live) {
          // Preserve the exact message text that peer-bus.ts expects to catch.
          throw new Error(`peer-bus name collision: ${selfName}`);
        }
        fs.unlinkSync(sockPath);
        await tryListen();
      }
      this.server = server;
      this.boundSockPath = sockPath;
    })();
  }

  async discover(selfName: string): Promise<BusPeer[]> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.busRoot);
    } catch {
      return [];
    }
    const candidates = entries
      .filter((f) => f.endsWith(".sock"))
      .map((f) => f.slice(0, -".sock".length));
    const results: BusPeer[] = [];
    for (const peerName of candidates) {
      const addr = path.join(this.busRoot, `${peerName}.sock`);
      if (peerName === selfName) {
        // Self is always included without probing.
        results.push({ name: peerName, addr });
        continue;
      }
      if (await this.isLive(peerName)) {
        results.push({ name: peerName, addr });
      } else {
        try { fs.unlinkSync(addr); } catch { /* noop */ }
      }
    }
    return results;
  }

  isLive(name: string): Promise<boolean> {
    const sockPath = path.join(this.busRoot, `${name}.sock`);
    return new Promise((resolve) => {
      const sock = net.connect(sockPath);
      const done = (live: boolean) => {
        sock.removeAllListeners();
        sock.destroy();
        resolve(live);
      };
      const timer = setTimeout(() => done(false), 200);
      sock.once("connect", () => {
        clearTimeout(timer);
        done(true);
      });
      sock.once("error", () => {
        clearTimeout(timer);
        done(false);
      });
    });
  }

  async close(): Promise<void> {
    const { server, boundSockPath } = this;
    this.server = undefined;
    this.boundSockPath = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (boundSockPath) {
      try { fs.unlinkSync(boundSockPath); } catch { /* noop */ }
    }
  }

  closeSync(): void {
    const { server, boundSockPath } = this;
    this.server = undefined;
    this.boundSockPath = undefined;
    if (server) {
      try { server.close(); } catch { /* noop */ }
    }
    if (boundSockPath) {
      try { fs.unlinkSync(boundSockPath); } catch { /* noop */ }
    }
  }
}

/**
 * Factory for the default Unix-socket transport.
 * peer-bus.ts depends on this so it can be swapped via the interface
 * without importing the class directly.
 */
export function createUnixSocketTransport(busRoot: string): BusTransport {
  return new UnixSocketTransport(busRoot);
}
