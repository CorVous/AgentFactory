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
// requestHumanApproval — loud-fail path (no UI)
// ---------------------------------------------------------------------------

describe("requestHumanApproval — loud-fail path", () => {
  it("returns false and writes to stderr when no UI is available", async () => {
    setHabitat({ ...BASE_HABITAT });
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

  it("returns false and writes to stderr when habitat is unset", async () => {
    // Don't call setHabitat — function should still loud-fail without throwing
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
