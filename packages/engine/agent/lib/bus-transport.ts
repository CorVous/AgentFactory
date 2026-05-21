// Shared low-level Unix-socket sender for agent-bus communications.
//
// Both agent-bus.ts's sendEnvelope and submission-emit.ts's makeBusSender
// open a socket to ${busRoot}/${toName}.sock, write one JSON line, and close.
// This module provides a single tested implementation so a future change
// (wire-format checksum, retry policy, etc.) has one home.

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
