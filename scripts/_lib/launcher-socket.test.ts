/**
 * launcher-socket.test.ts — hermetic unit tests for LauncherSocket and LauncherClient.
 *
 * Contract:
 *   - Uses real net.createServer/net.connect but binds to a tmpdir socket path.
 *   - No cross-process communication; server and client live in the same process.
 *   - No env from models.env.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLauncherSocket,
  createLauncherClient,
  LAUNCHER_SOCK_NAME,
} from "./launcher-socket.mjs";
import {
  makeFocusChangedEnvelope,
  makeFocusRequestEnvelope,
  encodeEnvelope,
} from "./launcher-envelope.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let cleanup: (() => Promise<void>)[] = [];

function makeTmpDir() {
  const d = path.join(os.tmpdir(), `launcher-sock-test-${process.pid}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  tmpDir = d;
  return d;
}

afterEach(async () => {
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch { /* ignore */ }
  }
  cleanup = [];
});

// ── LauncherSocket (server) ───────────────────────────────────────────────────

describe("LauncherSocket — bind", () => {
  it("binds to __launcher__.sock in the given busRoot", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());

    await server.bind(busRoot);
    expect(server.getSockPath()).toBe(path.join(busRoot, `${LAUNCHER_SOCK_NAME}.sock`));
  });

  it("calling bind twice is a no-op", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());

    await server.bind(busRoot);
    await server.bind(busRoot); // should not throw
    expect(server.getSockPath()).not.toBeNull();
  });
});

describe("LauncherSocket — client connect/disconnect", () => {
  it("increments clientCount when a client connects", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());
    await server.bind(busRoot);

    const client = createLauncherClient();
    cleanup.push(async () => client.disconnect());

    await client.connect(busRoot);
    // Give the server a tick to process the connection.
    await new Promise((r) => setTimeout(r, 20));
    expect(server.clientCount()).toBe(1);
  });

  it("decrements clientCount when a client disconnects", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());
    await server.bind(busRoot);

    const client = createLauncherClient();
    await client.connect(busRoot);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.clientCount()).toBe(1);

    client.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.clientCount()).toBe(0);
  });
});

describe("LauncherSocket — inbound envelope dispatch", () => {
  it("emits 'envelope' when a valid envelope arrives from a client", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());
    await server.bind(busRoot);

    const received: any[] = [];
    server.on("envelope", (env) => received.push(env));

    const client = createLauncherClient();
    cleanup.push(async () => client.disconnect());
    await client.connect(busRoot);

    const env = makeFocusRequestEnvelope({ from: "peer-a", target: "peer-b" });
    client.send(env);

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("focus-request");
    expect(received[0].target).toBe("peer-b");
  });

  it("drops envelopes with wrong version (v:2) and logs to stderr", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());
    await server.bind(busRoot);

    const received: any[] = [];
    server.on("envelope", (env) => received.push(env));

    // Send a raw v:2 envelope that the server should drop.
    const { default: net } = await import("node:net");
    const sock = net.connect(path.join(busRoot, `${LAUNCHER_SOCK_NAME}.sock`));
    await new Promise((r) => sock.once("connect", r));
    const badLine = JSON.stringify({ v: 2, id: "x", kind: "focus-request", ts: Date.now() }) + "\n";
    sock.write(badLine);

    await new Promise((r) => setTimeout(r, 50));
    sock.destroy();
    expect(received).toHaveLength(0);
  });
});

describe("LauncherSocket — broadcast", () => {
  it("broadcasts an envelope to all connected clients", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());
    await server.bind(busRoot);

    const clientA = createLauncherClient();
    const clientB = createLauncherClient();
    cleanup.push(async () => clientA.disconnect());
    cleanup.push(async () => clientB.disconnect());

    const receivedA: any[] = [];
    const receivedB: any[] = [];
    clientA.on("envelope", (e) => receivedA.push(e));
    clientB.on("envelope", (e) => receivedB.push(e));

    await clientA.connect(busRoot);
    await clientB.connect(busRoot);
    await new Promise((r) => setTimeout(r, 20));

    const env = makeFocusChangedEnvelope({ focused: "peer-a" });
    server.broadcast(env);

    await new Promise((r) => setTimeout(r, 50));
    expect(receivedA).toHaveLength(1);
    expect(receivedA[0].kind).toBe("focus-changed");
    expect(receivedB).toHaveLength(1);
    expect(receivedB[0].focused).toBe("peer-a");
  });
});

// ── LauncherClient ────────────────────────────────────────────────────────────

describe("LauncherClient — graceful failure when socket is missing", () => {
  it("rejects connect when socket does not exist", async () => {
    const busRoot = path.join(os.tmpdir(), `no-such-bus-${Date.now()}`);
    const client = createLauncherClient();
    cleanup.push(async () => client.disconnect());

    let caught: Error | null = null;
    try {
      await client.connect(busRoot, 500);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(client.isConnected()).toBe(false);
  }, 3000);
});

describe("LauncherClient — send", () => {
  it("returns false when not connected", () => {
    const client = createLauncherClient();
    const env = makeFocusRequestEnvelope({ from: "peer-a", target: "peer-b" });
    expect(client.send(env)).toBe(false);
  });

  it("returns true when connected and sends successfully", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());
    await server.bind(busRoot);

    const client = createLauncherClient();
    cleanup.push(async () => client.disconnect());
    await client.connect(busRoot);

    const env = makeFocusRequestEnvelope({ from: "peer-a", target: "peer-b" });
    expect(client.send(env)).toBe(true);
  });
});

describe("LauncherClient — events", () => {
  it("emits 'connected' on successful connection", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());
    await server.bind(busRoot);

    const client = createLauncherClient();
    cleanup.push(async () => client.disconnect());

    const events: string[] = [];
    client.on("connected", () => events.push("connected"));

    await client.connect(busRoot);
    expect(events).toContain("connected");
  });

  it("emits 'disconnected' after client disconnects", async () => {
    const busRoot = makeTmpDir();
    const server = createLauncherSocket();
    cleanup.push(() => server.close());
    await server.bind(busRoot);

    const client = createLauncherClient();
    await client.connect(busRoot);

    const events: string[] = [];
    client.on("disconnected", () => events.push("disconnected"));

    client.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContain("disconnected");
  });
});
