// Tests for the shared bus-transport helper.
//
// Uses a real local Unix socket server to exercise the happy path and
// a non-existent socket path for the ENOENT / "peer offline" case.
// The timeout case uses a server that accepts the connection but never
// reads, forcing the write callback to time out.

import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { sendOverBus, createUnixSocketTransport, type BusTransport } from "./bus-transport";

const tmpDir = mkdtempSync(join(tmpdir(), "bus-transport-test-"));

// Servers we need to close after each test
const openServers: net.Server[] = [];
// Transports we need to close after each test
const openTransports: BusTransport[] = [];

afterEach(async () => {
  for (const t of openTransports.splice(0)) {
    await t.close().catch(() => { /* noop */ });
  }
  for (const s of openServers.splice(0)) {
    await new Promise<void>((r) => {
      // closeAllConnections is Node 18+; fall back to close() for older.
      if (typeof (s as unknown as { closeAllConnections?: () => void }).closeAllConnections === "function") {
        (s as unknown as { closeAllConnections: () => void }).closeAllConnections();
      }
      s.close(() => r());
      // Safety: if close never calls back (open connections), resolve after 200ms.
      setTimeout(r, 200);
    });
  }
}, 5_000);

async function startEchoServer(sockPath: string): Promise<net.Server> {
  const server = net.createServer((conn) => {
    conn.resume(); // consume data without sending anything back
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });
  openServers.push(server);
  return server;
}

describe("sendOverBus", () => {
  it("returns {delivered:true} when the server is listening and accepts the write", async () => {
    const sockPath = join(tmpDir, "happy.sock");
    await startEchoServer(sockPath);
    // busRoot is the dir, toName is the filename stem
    const result = await sendOverBus(tmpDir, "happy", "some-line\n");
    expect(result.delivered).toBe(true);
  });

  it("returns {delivered:false, reason:'peer offline'} when socket file does not exist", async () => {
    const result = await sendOverBus(tmpDir, "nonexistent-peer", "line\n");
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("peer offline");
  });

  it("returns {delivered:false, reason:'peer offline'} when connection is refused (ECONNREFUSED)", async () => {
    const sockPath = join(tmpDir, "refused.sock");
    // Start and immediately close a server so the socket file exists but
    // nothing is listening — kernel returns ECONNREFUSED.
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    await new Promise<void>((r) => server.close(() => r()));
    const result = await sendOverBus(tmpDir, "refused", "line\n");
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("peer offline");
  });

  it("returns {delivered:false, reason:'timeout'} when the connection hangs (never emits connect)", async () => {
    // Simulate a socket path that exists but the listen backlog is full so
    // the connect event never fires. We achieve this by binding a server
    // with backlog=0 and not accepting connections, then trying to connect.
    // On Linux the actual timeout from the OS may vary, so we give sendOverBus
    // a very short timeoutMs to fire our timer before the OS does anything.
    //
    // Simplest reliable approach: use a path under /dev/null-like trick isn't
    // available, so instead we mock net.connect with a socket that stalls.
    //
    // Actually, the cleanest approach: start a TCP server (not Unix socket),
    // get a random port, then try to send to a socket file that maps to
    // something that never responds. We just use a custom backlog=1 server
    // that holds the connection in the backlog queue without accepting it.
    //
    // The most reliable test for "timeout" is to verify the timer fires when
    // no connect event arrives. We create a server that never calls accept
    // (backlog=0), saturate it, and then our connection hangs.
    //
    // Pragmatically: the implementation will return timeout if the write
    // callback never fires. We achieve that by creating a server that pauses
    // AND by sending enough data to overflow the kernel's send buffer.
    // On modern Linux send buffers are ~128KB; we send 4MB.
    const sockPath = join(tmpDir, "stall.sock");
    const stall = net.createServer((conn) => {
      conn.pause(); // stop reading — fill the recv buffer
    });
    await new Promise<void>((r) => stall.listen(sockPath, () => r()));
    openServers.push(stall);

    // 4 MB payload — far exceeds any kernel send buffer, so write() will
    // stall until the server reads. Since it never reads, the write callback
    // never fires and our timeout triggers.
    const result = await sendOverBus(tmpDir, "stall", "x".repeat(4 * 1024 * 1024) + "\n", 200);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("timeout");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// UnixSocketTransport tests
// ---------------------------------------------------------------------------

// Each test gets a fresh sub-directory under tmpDir to avoid socket-name
// collisions across tests running in the same tmpDir.
let subDirCounter = 0;
function makeBusRoot(): string {
  return mkdtempSync(join(tmpDir, `ust-${++subDirCounter}-`));
}

describe("UnixSocketTransport", () => {
  it("listen binds and onLine receives a newline-framed line sent via send (round-trip)", async () => {
    const busRoot = makeBusRoot();
    const receiver = createUnixSocketTransport(busRoot);
    openTransports.push(receiver);

    const received: string[] = [];
    await receiver.listen("peer-a", (line) => received.push(line));

    const sender = createUnixSocketTransport(busRoot);
    openTransports.push(sender);

    const result = await sender.send("peer-a", '{"hello":"world"}\n');
    expect(result.delivered).toBe(true);

    // Give the OS a moment to deliver the bytes to the server's onLine callback.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toBe('{"hello":"world"}');
  });

  it("listen reclaims a stale socket (EADDRINUSE + not-live)", async () => {
    const busRoot = makeBusRoot();
    const sockPath = join(busRoot, "stale-peer.sock");

    // Create a stale socket by starting a server and immediately closing it
    // (socket file stays on disk but nothing listens — ECONNREFUSED).
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(sockPath, () => r()));
    await new Promise<void>((r) => dead.close(() => r()));

    // Now try to bind to the same name — should succeed by reclaiming the stale socket.
    const transport = createUnixSocketTransport(busRoot);
    openTransports.push(transport);
    await expect(transport.listen("stale-peer", () => {})).resolves.toBeUndefined();
  });

  it("listen rejects with 'peer-bus name collision: <name>' when a live peer already holds the name", async () => {
    const busRoot = makeBusRoot();

    const first = createUnixSocketTransport(busRoot);
    openTransports.push(first);
    await first.listen("live-peer", () => {});

    const second = createUnixSocketTransport(busRoot);
    openTransports.push(second);
    await expect(second.listen("live-peer", () => {})).rejects.toThrow(
      "peer-bus name collision: live-peer",
    );
  });

  it("discover returns self (unprobed) + a live peer, and unlinks a dead peer's socket", async () => {
    const busRoot = makeBusRoot();

    // Start a live peer
    const livePeer = createUnixSocketTransport(busRoot);
    openTransports.push(livePeer);
    await livePeer.listen("peer-live", () => {});

    // Create a stale socket for a dead peer
    const deadSockPath = join(busRoot, "peer-dead.sock");
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(deadSockPath, () => r()));
    await new Promise<void>((r) => dead.close(() => r()));

    // Discover from self's perspective
    const self = createUnixSocketTransport(busRoot);
    openTransports.push(self);
    await self.listen("peer-self", () => {});

    const peers = await self.discover("peer-self");
    const names = peers.map((p) => p.name).sort();

    // Should find self and live-peer; dead-peer should be cleaned up
    expect(names).toContain("peer-self");
    expect(names).toContain("peer-live");
    expect(names).not.toContain("peer-dead");

    // The dead socket file should have been unlinked
    expect(() => statSync(deadSockPath)).toThrow();
  });

  it("close removes the bound socket file; subsequent listen on same name succeeds", async () => {
    const busRoot = makeBusRoot();
    const sockPath = join(busRoot, "peer-close.sock");

    const transport = createUnixSocketTransport(busRoot);
    await transport.listen("peer-close", () => {});

    // Socket file should exist
    expect(() => statSync(sockPath)).not.toThrow();

    await transport.close();

    // Socket file should be gone
    expect(() => statSync(sockPath)).toThrow();

    // A new transport can now rebind the same name
    const transport2 = createUnixSocketTransport(busRoot);
    openTransports.push(transport2);
    await expect(transport2.listen("peer-close", () => {})).resolves.toBeUndefined();
  });

  it("send to an offline peer returns {delivered:false, reason:'peer offline'} and unlinks the leftover dead socket", async () => {
    const busRoot = makeBusRoot();

    // Create a stale socket (dead peer)
    const deadSockPath = join(busRoot, "peer-gone.sock");
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(deadSockPath, () => r()));
    await new Promise<void>((r) => dead.close(() => r()));

    const sender = createUnixSocketTransport(busRoot);
    openTransports.push(sender);

    const result = await sender.send("peer-gone", '{"msg":"hi"}\n');
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("peer offline");

    // The stale socket file should have been unlinked by the transport
    expect(() => statSync(deadSockPath)).toThrow();
  });
});
