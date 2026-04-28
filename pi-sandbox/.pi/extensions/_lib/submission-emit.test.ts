import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Envelope } from "./bus-envelope";
import {
  buildWriteArtifact,
  buildEditArtifact,
  buildMoveArtifact,
  buildDeleteArtifact,
  getPendingSubmissions,
  shipSubmission,
  dispatchSubmissionReply,
  type ShipContext,
  type PendingSubmission,
} from "./submission-emit";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// Reset global pending-submissions map between tests.
beforeEach(() => {
  (globalThis as { __pi_pending_submissions__?: unknown }).__pi_pending_submissions__ = undefined;
});
afterEach(() => {
  (globalThis as { __pi_pending_submissions__?: unknown }).__pi_pending_submissions__ = undefined;
});

// ---------------------------------------------------------------------------
// Artifact builders
// ---------------------------------------------------------------------------

describe("buildWriteArtifact", () => {
  it("returns kind=write with correct relPath, content, and sha256", () => {
    const content = "hello world";
    const a = buildWriteArtifact({ relPath: "foo/bar.txt", content });
    expect(a.kind).toBe("write");
    if (a.kind !== "write") return;
    expect(a.relPath).toBe("foo/bar.txt");
    expect(a.content).toBe(content);
    expect(a.sha256).toBe(sha256(content));
  });

  it("sha256 differs for different content", () => {
    const a1 = buildWriteArtifact({ relPath: "f.txt", content: "aaa" });
    const a2 = buildWriteArtifact({ relPath: "f.txt", content: "bbb" });
    if (a1.kind !== "write" || a2.kind !== "write") return;
    expect(a1.sha256).not.toBe(a2.sha256);
  });
});

describe("buildEditArtifact", () => {
  it("returns kind=edit with relPath, sha256OfOriginal, and edits", () => {
    const original = "original content";
    const a = buildEditArtifact({
      relPath: "src/a.ts",
      originalContent: original,
      edits: [{ oldString: "original", newString: "replaced" }],
    });
    expect(a.kind).toBe("edit");
    if (a.kind !== "edit") return;
    expect(a.relPath).toBe("src/a.ts");
    expect(a.sha256OfOriginal).toBe(sha256(original));
    expect(a.edits).toEqual([{ oldString: "original", newString: "replaced" }]);
  });

  it("sha256OfOriginal reflects the original not the patched content", () => {
    const original = "old";
    const a = buildEditArtifact({
      relPath: "f.ts",
      originalContent: original,
      edits: [{ oldString: "old", newString: "new" }],
    });
    if (a.kind !== "edit") return;
    expect(a.sha256OfOriginal).toBe(sha256("old"));
    expect(a.sha256OfOriginal).not.toBe(sha256("new"));
  });
});

describe("buildMoveArtifact", () => {
  it("returns kind=move with src, dst, sha256OfSource", () => {
    const content = "source file content";
    const a = buildMoveArtifact({ src: "a/b.ts", dst: "c/d.ts", sourceContent: content });
    expect(a.kind).toBe("move");
    if (a.kind !== "move") return;
    expect(a.src).toBe("a/b.ts");
    expect(a.dst).toBe("c/d.ts");
    expect(a.sha256OfSource).toBe(sha256(content));
  });
});

describe("buildDeleteArtifact", () => {
  it("returns kind=delete with relPath and sha256", () => {
    const content = "file to delete";
    const a = buildDeleteArtifact({ relPath: "old.ts", content });
    expect(a.kind).toBe("delete");
    if (a.kind !== "delete") return;
    expect(a.relPath).toBe("old.ts");
    expect(a.sha256).toBe(sha256(content));
  });
});

// ---------------------------------------------------------------------------
// shipSubmission — envelope construction and pending registration
// ---------------------------------------------------------------------------

describe("shipSubmission — basic send and pending registration", () => {
  it("calls sendEnvelope with a submission envelope", async () => {
    const mockSender = vi.fn().mockResolvedValue({ delivered: true });
    const ctx: ShipContext = {
      busRoot: "/tmp/bus",
      agentName: "worker",
      submitTo: "supervisor",
      sendEnvelope: mockSender,
      timeoutMs: 60_000,
    };
    const artifacts = [buildWriteArtifact({ relPath: "a.txt", content: "hi" })];
    const p = shipSubmission(ctx, artifacts, "1 write");
    // flush microtasks so sendEnvelope resolves and pending entry is registered
    await new Promise<void>((r) => setImmediate(r));

    expect(mockSender).toHaveBeenCalledOnce();
    const env = mockSender.mock.calls[0][0] as Envelope;
    expect(env.v).toBe(2);
    expect(env.from).toBe("worker");
    expect(env.to).toBe("supervisor");
    expect(env.payload.kind).toBe("submission");
    if (env.payload.kind === "submission") {
      expect(env.payload.artifacts).toHaveLength(1);
      expect(env.payload.summary).toBe("1 write");
    }

    // clean up pending entry to avoid hanging promise / timer leak
    const pending = [...getPendingSubmissions().values()][0];
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ approved: false });
    }
    await p.catch(() => {});
  });

  it("registers a pending entry keyed by the envelope msg_id", async () => {
    let capturedMsgId = "";
    const mockSender = vi.fn().mockImplementation(async (env: Envelope) => {
      capturedMsgId = env.msg_id;
      return { delivered: true };
    });
    const ctx: ShipContext = {
      busRoot: "/tmp/bus",
      agentName: "worker",
      submitTo: "supervisor",
      sendEnvelope: mockSender,
      timeoutMs: 60_000,
    };
    const p = shipSubmission(ctx, [], "empty");
    await new Promise<void>((r) => setImmediate(r));

    expect(getPendingSubmissions().has(capturedMsgId)).toBe(true);

    // cleanup
    const pending = getPendingSubmissions().get(capturedMsgId)!;
    clearTimeout(pending.timer);
    pending.resolve({ approved: false });
    await p.catch(() => {});
  });

  it("omits summary from envelope when not provided", async () => {
    const mockSender = vi.fn().mockResolvedValue({ delivered: true });
    const ctx: ShipContext = {
      busRoot: "/tmp",
      agentName: "a",
      submitTo: "b",
      sendEnvelope: mockSender,
      timeoutMs: 60_000,
    };
    const p = shipSubmission(ctx, []);
    await new Promise<void>((r) => setImmediate(r));
    const env = mockSender.mock.calls[0][0] as Envelope;
    if (env.payload.kind === "submission") {
      expect(env.payload.summary).toBeUndefined();
    }
    const pending = [...getPendingSubmissions().values()][0];
    if (pending) { clearTimeout(pending.timer); pending.resolve({ approved: false }); }
    await p.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// shipSubmission — delivery failure
// ---------------------------------------------------------------------------

describe("shipSubmission — delivery failure", () => {
  it("rejects when sendEnvelope returns delivered:false", async () => {
    const mockSender = vi.fn().mockResolvedValue({ delivered: false, reason: "peer offline" });
    const ctx: ShipContext = {
      busRoot: "/tmp",
      agentName: "worker",
      submitTo: "sup",
      sendEnvelope: mockSender,
      timeoutMs: 60_000,
    };
    await expect(shipSubmission(ctx, [])).rejects.toThrow("peer offline");
    expect(getPendingSubmissions().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shipSubmission — timeout
// ---------------------------------------------------------------------------

describe("shipSubmission — timeout", () => {
  it("rejects after timeoutMs with a descriptive error", async () => {
    const mockSender = vi.fn().mockResolvedValue({ delivered: true });
    const ctx: ShipContext = {
      busRoot: "/tmp",
      agentName: "worker",
      submitTo: "sup",
      sendEnvelope: mockSender,
      timeoutMs: 10, // very short
    };
    await expect(shipSubmission(ctx, [])).rejects.toThrow("timed out");
    // pending entry should be cleaned up
    expect(getPendingSubmissions().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dispatchSubmissionReply — routing logic
// ---------------------------------------------------------------------------

describe("dispatchSubmissionReply", () => {
  it("returns false when envelope has no in_reply_to", () => {
    const env = {
      v: 2,
      msg_id: "abc",
      from: "sup",
      to: "worker",
      ts: Date.now(),
      payload: { kind: "approval-result" as const, approved: true },
    } as Envelope;
    expect(dispatchSubmissionReply(env)).toBe(false);
  });

  it("returns false when envelope kind is message (not a reply kind)", () => {
    const env = {
      v: 2,
      msg_id: "abc",
      from: "sup",
      to: "worker",
      ts: Date.now(),
      in_reply_to: "xyz",
      payload: { kind: "message" as const, text: "hi" },
    } as Envelope;
    expect(dispatchSubmissionReply(env)).toBe(false);
  });

  it("returns false when no pending entry matches in_reply_to", () => {
    const env = {
      v: 2,
      msg_id: "abc",
      from: "sup",
      to: "worker",
      ts: Date.now(),
      in_reply_to: "nonexistent-id",
      payload: { kind: "approval-result" as const, approved: true },
    } as Envelope;
    expect(dispatchSubmissionReply(env)).toBe(false);
  });

  it("resolves pending with {approved:true} on approval-result approved:true", async () => {
    // Manually plant a pending entry
    const result = await new Promise<{ approved: boolean; note?: string; revisionNote?: string }>((resolve) => {
      const timer = setTimeout(() => {}, 60_000);
      getPendingSubmissions().set("msg-1", {
        resolve,
        reject: () => {},
        timer,
      });

      const env: Envelope = {
        v: 2,
        msg_id: "reply-1",
        from: "sup",
        to: "worker",
        ts: Date.now(),
        in_reply_to: "msg-1",
        payload: { kind: "approval-result", approved: true },
      };
      dispatchSubmissionReply(env);
    });
    expect(result.approved).toBe(true);
    expect(result.note).toBeUndefined();
    expect(getPendingSubmissions().has("msg-1")).toBe(false);
  });

  it("resolves pending with {approved:false, note} on approval-result approved:false with note", async () => {
    const result = await new Promise<{ approved: boolean; note?: string; revisionNote?: string }>((resolve) => {
      const timer = setTimeout(() => {}, 60_000);
      getPendingSubmissions().set("msg-2", { resolve, reject: () => {}, timer });

      const env: Envelope = {
        v: 2,
        msg_id: "reply-2",
        from: "sup",
        to: "worker",
        ts: Date.now(),
        in_reply_to: "msg-2",
        payload: { kind: "approval-result", approved: false, note: "not ready" },
      };
      dispatchSubmissionReply(env);
    });
    expect(result.approved).toBe(false);
    expect(result.note).toBe("not ready");
    expect(result.revisionNote).toBeUndefined();
  });

  it("resolves pending with {approved:false, revisionNote} on revision-requested", async () => {
    const result = await new Promise<{ approved: boolean; note?: string; revisionNote?: string }>((resolve) => {
      const timer = setTimeout(() => {}, 60_000);
      getPendingSubmissions().set("msg-3", { resolve, reject: () => {}, timer });

      const env: Envelope = {
        v: 2,
        msg_id: "reply-3",
        from: "sup",
        to: "worker",
        ts: Date.now(),
        in_reply_to: "msg-3",
        payload: { kind: "revision-requested", note: "please fix indentation" },
      };
      dispatchSubmissionReply(env);
    });
    expect(result.approved).toBe(false);
    expect(result.revisionNote).toBe("please fix indentation");
    expect(result.note).toBeUndefined();
  });

  it("clears the timer when resolving", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const fakeTimer = setTimeout(() => {}, 60_000);
    getPendingSubmissions().set("msg-4", {
      resolve: () => {},
      reject: () => {},
      timer: fakeTimer,
    });

    dispatchSubmissionReply({
      v: 2,
      msg_id: "r",
      from: "sup",
      to: "w",
      ts: Date.now(),
      in_reply_to: "msg-4",
      payload: { kind: "approval-result", approved: true },
    });

    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
    clearSpy.mockRestore();
  });

  it("returns true when a pending entry is found and dispatched", () => {
    const timer = setTimeout(() => {}, 60_000);
    getPendingSubmissions().set("msg-5", { resolve: () => {}, reject: () => {}, timer });
    const result = dispatchSubmissionReply({
      v: 2,
      msg_id: "r",
      from: "sup",
      to: "w",
      ts: Date.now(),
      in_reply_to: "msg-5",
      payload: { kind: "approval-result", approved: true },
    });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: shipSubmission + dispatchSubmissionReply
// ---------------------------------------------------------------------------

describe("shipSubmission + dispatchSubmissionReply end-to-end", () => {
  it("resolves the shipSubmission promise when dispatchSubmissionReply is called", async () => {
    let capturedMsgId = "";
    const mockSender = vi.fn().mockImplementation(async (env: Envelope) => {
      capturedMsgId = env.msg_id;
      return { delivered: true };
    });
    const ctx: ShipContext = {
      busRoot: "/tmp",
      agentName: "worker",
      submitTo: "sup",
      sendEnvelope: mockSender,
      timeoutMs: 60_000,
    };

    const promise = shipSubmission(ctx, [], "nothing");
    await new Promise<void>((r) => setImmediate(r));

    dispatchSubmissionReply({
      v: 2,
      msg_id: "reply-x",
      from: "sup",
      to: "worker",
      ts: Date.now(),
      in_reply_to: capturedMsgId,
      payload: { kind: "approval-result", approved: true, note: "lgtm" },
    });

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.note).toBe("lgtm");
    expect(getPendingSubmissions().size).toBe(0);
  });
});
