import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setHabitat, type Habitat } from "./habitat";

// We test requestHumanApproval through its public interface only.
// The function is imported lazily after habitat state is set up.

const BASE_HABITAT: Habitat = {
  agentName: "test-agent",
  scratchRoot: "/tmp/scratch",
  busRoot: "/tmp/bus",
  skills: [],
  agents: [],
  noEditAdd: [],
  noEditSkip: [],
  acceptedFrom: [],
  peers: [],
};

beforeEach(() => {
  (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__ = undefined;
});

afterEach(() => {
  (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__ = undefined;
});

// ---------------------------------------------------------------------------
// requestHumanApproval — ctx.hasUI path
// ---------------------------------------------------------------------------

describe("requestHumanApproval — ctx.hasUI", () => {
  it("calls ctx.ui.confirm and returns its result (true)", async () => {
    const { requestHumanApproval } = await import("./escalation");
    const ctx = {
      hasUI: true,
      ui: { confirm: vi.fn().mockResolvedValue(true) },
    } as unknown as Parameters<typeof requestHumanApproval>[0];
    const pi = {} as Parameters<typeof requestHumanApproval>[1];
    const result = await requestHumanApproval(ctx, pi, {
      title: "Apply changes?",
      summary: "3 writes",
      preview: "a.txt\nb.txt",
    });
    expect(result).toBe(true);
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Apply changes?", "a.txt\nb.txt");
  });

  it("calls ctx.ui.confirm and returns its result (false)", async () => {
    const { requestHumanApproval } = await import("./escalation");
    const ctx = {
      hasUI: true,
      ui: { confirm: vi.fn().mockResolvedValue(false) },
    } as unknown as Parameters<typeof requestHumanApproval>[0];
    const pi = {} as Parameters<typeof requestHumanApproval>[1];
    const result = await requestHumanApproval(ctx, pi, {
      title: "Apply?",
      summary: "s",
      preview: "p",
    });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requestHumanApproval — loud-fail path (no UI, no rpcSock)
// ---------------------------------------------------------------------------

describe("requestHumanApproval — loud-fail path", () => {
  it("returns false and writes to stderr when no UI and rpcSock is unset", async () => {
    setHabitat({ ...BASE_HABITAT, rpcSock: undefined });
    const { requestHumanApproval } = await import("./escalation");
    const ctx = { hasUI: false, ui: { confirm: vi.fn() } } as unknown as Parameters<typeof requestHumanApproval>[0];
    const pi = {} as Parameters<typeof requestHumanApproval>[1];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await requestHumanApproval(ctx, pi, {
        title: "T",
        summary: "S",
        preview: "P",
      });
      expect(result).toBe(false);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[deferred] dropped"));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("returns false and writes to stderr when getHabitat throws", async () => {
    // Don't call setHabitat — getHabitat() will throw
    const { requestHumanApproval } = await import("./escalation");
    const ctx = { hasUI: false, ui: { confirm: vi.fn() } } as unknown as Parameters<typeof requestHumanApproval>[0];
    const pi = {} as Parameters<typeof requestHumanApproval>[1];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await requestHumanApproval(ctx, pi, {
        title: "T2",
        summary: "S2",
        preview: "P2",
      });
      expect(result).toBe(false);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[deferred] dropped"));
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// requestHumanApproval — RPC round-trip path
// ---------------------------------------------------------------------------

describe("requestHumanApproval — rpc round-trip", () => {
  let server: net.Server;
  let sockPath: string;

  beforeEach(() => {
    sockPath = path.join(os.tmpdir(), `escalation-test-${process.pid}-${Date.now()}.sock`);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try { fs.unlinkSync(sockPath); } catch { /* noop */ }
  });

  it("sends request-approval and resolves true when server replies approved:true", async () => {
    server = net.createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        const msg = JSON.parse(line) as { type?: string };
        expect(msg.type).toBe("request-approval");
        conn.write(JSON.stringify({ type: "approval-result", approved: true }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));

    setHabitat({ ...BASE_HABITAT, rpcSock: sockPath });
    const { requestHumanApproval } = await import("./escalation");
    const ctx = { hasUI: false } as unknown as Parameters<typeof requestHumanApproval>[0];
    const pi = {} as Parameters<typeof requestHumanApproval>[1];
    const result = await requestHumanApproval(ctx, pi, {
      title: "Apply?",
      summary: "s",
      preview: "p",
    });
    expect(result).toBe(true);
  });

  it("sends request-approval and resolves false when server replies approved:false", async () => {
    server = net.createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        conn.write(JSON.stringify({ type: "approval-result", approved: false }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));

    setHabitat({ ...BASE_HABITAT, rpcSock: sockPath });
    const { requestHumanApproval } = await import("./escalation");
    const ctx = { hasUI: false } as unknown as Parameters<typeof requestHumanApproval>[0];
    const pi = {} as Parameters<typeof requestHumanApproval>[1];
    const result = await requestHumanApproval(ctx, pi, {
      title: "Apply?",
      summary: "s",
      preview: "p",
    });
    expect(result).toBe(false);
  });

  it("resolves false when server closes without replying", async () => {
    server = net.createServer((conn) => {
      conn.destroy(); // close without reply
    });
    await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));

    setHabitat({ ...BASE_HABITAT, rpcSock: sockPath });
    const { requestHumanApproval } = await import("./escalation");
    const ctx = { hasUI: false } as unknown as Parameters<typeof requestHumanApproval>[0];
    const pi = {} as Parameters<typeof requestHumanApproval>[1];
    const result = await requestHumanApproval(ctx, pi, {
      title: "Apply?",
      summary: "s",
      preview: "p",
    });
    expect(result).toBe(false);
  });

  it("resolves false when peer is not listening (ENOENT/ECONNREFUSED)", async () => {
    // sockPath doesn't exist — no server started
    setHabitat({ ...BASE_HABITAT, rpcSock: sockPath });
    const { requestHumanApproval } = await import("./escalation");
    const ctx = { hasUI: false } as unknown as Parameters<typeof requestHumanApproval>[0];
    const pi = {} as Parameters<typeof requestHumanApproval>[1];
    const result = await requestHumanApproval(ctx, pi, {
      title: "Apply?",
      summary: "s",
      preview: "p",
    });
    expect(result).toBe(false);
  });

  it("sends the request with title, summary, preview fields", async () => {
    let received: Record<string, unknown> = {};
    server = net.createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        received = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        conn.write(JSON.stringify({ type: "approval-result", approved: true }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));

    setHabitat({ ...BASE_HABITAT, rpcSock: sockPath });
    const { requestHumanApproval } = await import("./escalation");
    const ctx = { hasUI: false } as unknown as Parameters<typeof requestHumanApproval>[0];
    const pi = {} as Parameters<typeof requestHumanApproval>[1];
    await requestHumanApproval(ctx, pi, {
      title: "My title",
      summary: "my summary",
      preview: "my preview",
    });
    expect(received.type).toBe("request-approval");
    expect(received.title).toBe("My title");
    expect(received.summary).toBe("my summary");
    expect(received.preview).toBe("my preview");
  });
});
