import { describe, expect, it } from "vitest";
import {
  encodeEnvelope,
  makeApprovalRequestEnvelope,
  makeApprovalResultEnvelope,
  makeMessageEnvelope,
  makeRevisionRequestedEnvelope,
  makeSubmissionEnvelope,
  renderInboundForUser,
  tryDecodeEnvelope,
  type Artifact,
  type Envelope,
} from "./bus-envelope";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("makeMessageEnvelope", () => {
  it("produces a v:2 message envelope with a fresh UUID and current ts", () => {
    const before = Date.now();
    const env = makeMessageEnvelope({ from: "planner", to: "worker-a", text: "hello" });
    const after = Date.now();

    expect(env.v).toBe(2);
    expect(env.msg_id).toMatch(UUID_RE);
    expect(env.from).toBe("planner");
    expect(env.to).toBe("worker-a");
    expect(env.ts).toBeGreaterThanOrEqual(before);
    expect(env.ts).toBeLessThanOrEqual(after);
    expect(env.payload).toEqual({ kind: "message", text: "hello" });
    expect(env.in_reply_to).toBeUndefined();
  });

  it("carries in_reply_to when supplied", () => {
    const env = makeMessageEnvelope({
      from: "worker-a",
      to: "planner",
      text: "pong",
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
    });
    expect(env.in_reply_to).toBe("abc12345-0000-0000-0000-000000000000");
  });

  it("omits in_reply_to from JSON when not supplied", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "x" });
    const json = JSON.parse(encodeEnvelope(env));
    expect("in_reply_to" in json).toBe(false);
  });
});

describe("encodeEnvelope", () => {
  it("produces a single line ending in newline", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "hi" });
    const wire = encodeEnvelope(env);
    expect(wire.endsWith("\n")).toBe(true);
    expect(wire.slice(0, -1).includes("\n")).toBe(false);
  });

  it("round-trips through tryDecodeEnvelope", () => {
    const env = makeMessageEnvelope({
      from: "planner",
      to: "worker-a",
      text: "hello\tworld",
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
    });
    const decoded = tryDecodeEnvelope(encodeEnvelope(env));
    expect(decoded).toEqual(env);
  });
});

describe("tryDecodeEnvelope", () => {
  const valid: Envelope = {
    v: 2,
    msg_id: "abc12345-0000-0000-0000-000000000000",
    from: "a",
    to: "b",
    ts: 1700000000000,
    payload: { kind: "message", text: "hi" },
  };

  it("returns null for non-JSON input", () => {
    expect(tryDecodeEnvelope("not json")).toBeNull();
  });

  it("returns null for v:1 envelopes", () => {
    expect(tryDecodeEnvelope(JSON.stringify({ ...valid, v: 1 }))).toBeNull();
  });

  it("returns null for v:3 envelopes", () => {
    expect(tryDecodeEnvelope(JSON.stringify({ ...valid, v: 3 }))).toBeNull();
  });

  it("returns null when payload is missing", () => {
    const { payload: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null for unknown payload kind", () => {
    expect(
      tryDecodeEnvelope(JSON.stringify({ ...valid, payload: { kind: "unknown-kind" } })),
    ).toBeNull();
  });

  // approval-request
  it("accepts a well-formed approval-request payload", () => {
    const env = { ...valid, payload: { kind: "approval-request", title: "T", summary: "S", preview: "P" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).not.toBeNull();
  });
  it("returns null when approval-request title is missing", () => {
    const env = { ...valid, payload: { kind: "approval-request", summary: "S", preview: "P" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("returns null when approval-request summary is not a string", () => {
    const env = { ...valid, payload: { kind: "approval-request", title: "T", summary: 42, preview: "P" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("returns null when approval-request preview is missing", () => {
    const env = { ...valid, payload: { kind: "approval-request", title: "T", summary: "S" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });

  // approval-result
  it("accepts a well-formed approval-result payload", () => {
    const env = { ...valid, payload: { kind: "approval-result", approved: false } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).not.toBeNull();
  });
  it("accepts approval-result with optional note", () => {
    const env = { ...valid, payload: { kind: "approval-result", approved: true, note: "LGTM" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).not.toBeNull();
  });
  it("returns null when approval-result approved is missing", () => {
    const env = { ...valid, payload: { kind: "approval-result" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("returns null when approval-result approved is not a boolean", () => {
    const env = { ...valid, payload: { kind: "approval-result", approved: "yes" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });

  // revision-requested
  it("accepts a well-formed revision-requested payload", () => {
    const env = { ...valid, payload: { kind: "revision-requested", note: "Fix it" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).not.toBeNull();
  });
  it("returns null when revision-requested note is missing", () => {
    const env = { ...valid, payload: { kind: "revision-requested" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("returns null when revision-requested note is not a string", () => {
    const env = { ...valid, payload: { kind: "revision-requested", note: 99 } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });

  // submission
  it("accepts a well-formed submission payload with a write artifact", () => {
    const env = {
      ...valid,
      payload: {
        kind: "submission",
        artifacts: [{ kind: "write", relPath: "a.txt", content: "hi", sha256: "abc" }],
      },
    };
    expect(tryDecodeEnvelope(JSON.stringify(env))).not.toBeNull();
  });
  it("accepts submission with optional summary", () => {
    const env = {
      ...valid,
      payload: {
        kind: "submission",
        artifacts: [{ kind: "write", relPath: "a.txt", content: "hi", sha256: "abc" }],
        summary: "one file",
      },
    };
    expect(tryDecodeEnvelope(JSON.stringify(env))).not.toBeNull();
  });
  it("returns null when submission artifacts is missing", () => {
    const env = { ...valid, payload: { kind: "submission" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("returns null when submission artifacts is not an array", () => {
    const env = { ...valid, payload: { kind: "submission", artifacts: "nope" } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("returns null when a submission artifact has an unknown kind", () => {
    const env = { ...valid, payload: { kind: "submission", artifacts: [{ kind: "unknown" }] } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("returns null when a write artifact is missing relPath", () => {
    const env = { ...valid, payload: { kind: "submission", artifacts: [{ kind: "write", content: "x", sha256: "y" }] } };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("returns null when an edit artifact is missing edits", () => {
    const env = {
      ...valid,
      payload: {
        kind: "submission",
        artifacts: [{ kind: "edit", relPath: "a.ts", sha256OfOriginal: "abc" }],
      },
    };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("accepts a well-formed edit artifact", () => {
    const env = {
      ...valid,
      payload: {
        kind: "submission",
        artifacts: [{ kind: "edit", relPath: "a.ts", sha256OfOriginal: "abc", edits: [{ oldString: "x", newString: "y" }] }],
      },
    };
    expect(tryDecodeEnvelope(JSON.stringify(env))).not.toBeNull();
  });
  it("accepts a well-formed move artifact", () => {
    const env = {
      ...valid,
      payload: { kind: "submission", artifacts: [{ kind: "move", src: "a.ts", dst: "b.ts", sha256OfSource: "abc" }] },
    };
    expect(tryDecodeEnvelope(JSON.stringify(env))).not.toBeNull();
  });
  it("returns null when a move artifact is missing dst", () => {
    const env = {
      ...valid,
      payload: { kind: "submission", artifacts: [{ kind: "move", src: "a.ts", sha256OfSource: "abc" }] },
    };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });
  it("accepts a well-formed delete artifact", () => {
    const env = {
      ...valid,
      payload: { kind: "submission", artifacts: [{ kind: "delete", relPath: "a.ts", sha256: "abc" }] },
    };
    expect(tryDecodeEnvelope(JSON.stringify(env))).not.toBeNull();
  });
  it("returns null when a delete artifact is missing sha256", () => {
    const env = {
      ...valid,
      payload: { kind: "submission", artifacts: [{ kind: "delete", relPath: "a.ts" }] },
    };
    expect(tryDecodeEnvelope(JSON.stringify(env))).toBeNull();
  });

  it("returns null when from is missing", () => {
    const { from: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null when msg_id is missing", () => {
    const { msg_id: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null when to is missing", () => {
    const { to: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null when ts is missing", () => {
    const { ts: _, ...rest } = valid;
    expect(tryDecodeEnvelope(JSON.stringify(rest))).toBeNull();
  });

  it("returns null when payload.text is not a string", () => {
    expect(
      tryDecodeEnvelope(JSON.stringify({ ...valid, payload: { kind: "message", text: 42 } })),
    ).toBeNull();
  });

  it("returns null when ts is not a number", () => {
    expect(tryDecodeEnvelope(JSON.stringify({ ...valid, ts: "now" }))).toBeNull();
  });

  it("accepts a well-formed v:2 message envelope", () => {
    expect(tryDecodeEnvelope(JSON.stringify(valid))).toEqual(valid);
  });
});

describe("makeApprovalRequestEnvelope", () => {
  it("produces a v:2 approval-request envelope with required fields", () => {
    const before = Date.now();
    const env = makeApprovalRequestEnvelope({
      from: "supervisor",
      to: "worker-a",
      title: "Review draft",
      summary: "Worker produced 3 files",
      preview: "hello.txt: Hi\n",
    });
    const after = Date.now();

    expect(env.v).toBe(2);
    expect(env.msg_id).toMatch(UUID_RE);
    expect(env.from).toBe("supervisor");
    expect(env.to).toBe("worker-a");
    expect(env.ts).toBeGreaterThanOrEqual(before);
    expect(env.ts).toBeLessThanOrEqual(after);
    expect(env.payload).toEqual({
      kind: "approval-request",
      title: "Review draft",
      summary: "Worker produced 3 files",
      preview: "hello.txt: Hi\n",
    });
    expect(env.in_reply_to).toBeUndefined();
  });

  it("carries in_reply_to when supplied", () => {
    const env = makeApprovalRequestEnvelope({
      from: "supervisor",
      to: "worker-a",
      title: "Re-review",
      summary: "Second attempt",
      preview: "",
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
    });
    expect(env.in_reply_to).toBe("abc12345-0000-0000-0000-000000000000");
  });
});

describe("makeApprovalResultEnvelope", () => {
  it("produces a v:2 approval-result envelope with approved:true", () => {
    const env = makeApprovalResultEnvelope({
      from: "supervisor",
      to: "worker-a",
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
      approved: true,
    });
    expect(env.v).toBe(2);
    expect(env.msg_id).toMatch(UUID_RE);
    expect(env.payload).toEqual({ kind: "approval-result", approved: true });
    expect(env.in_reply_to).toBe("abc12345-0000-0000-0000-000000000000");
  });

  it("carries optional note", () => {
    const env = makeApprovalResultEnvelope({
      from: "supervisor",
      to: "worker-a",
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
      approved: false,
      note: "Too verbose",
    });
    expect(env.payload).toEqual({ kind: "approval-result", approved: false, note: "Too verbose" });
  });
});

describe("makeRevisionRequestedEnvelope", () => {
  it("produces a v:2 revision-requested envelope with a required note", () => {
    const env = makeRevisionRequestedEnvelope({
      from: "supervisor",
      to: "worker-a",
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
      note: "Please add error handling",
    });
    expect(env.v).toBe(2);
    expect(env.msg_id).toMatch(UUID_RE);
    expect(env.payload).toEqual({ kind: "revision-requested", note: "Please add error handling" });
    expect(env.in_reply_to).toBe("abc12345-0000-0000-0000-000000000000");
  });
});

describe("makeSubmissionEnvelope", () => {
  const writeArtifact: Artifact = {
    kind: "write",
    relPath: "hello.txt",
    content: "Hi",
    sha256: "abc123",
  };

  it("produces a v:2 submission envelope with artifacts", () => {
    const env = makeSubmissionEnvelope({
      from: "worker-a",
      to: "supervisor",
      artifacts: [writeArtifact],
    });
    expect(env.v).toBe(2);
    expect(env.msg_id).toMatch(UUID_RE);
    expect(env.payload).toEqual({ kind: "submission", artifacts: [writeArtifact] });
    expect(env.in_reply_to).toBeUndefined();
  });

  it("carries optional summary and in_reply_to", () => {
    const env = makeSubmissionEnvelope({
      from: "worker-a",
      to: "supervisor",
      artifacts: [writeArtifact],
      summary: "Created hello.txt",
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
    });
    expect(env.payload).toEqual({
      kind: "submission",
      artifacts: [writeArtifact],
      summary: "Created hello.txt",
    });
    expect(env.in_reply_to).toBe("abc12345-0000-0000-0000-000000000000");
  });
});

describe("renderInboundForUser", () => {
  it("formats without in_reply_to", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "abc12345-0000-0000-0000-000000000000",
      from: "planner",
      to: "worker-a",
      ts: 0,
      payload: { kind: "message", text: "ping" },
    };
    expect(renderInboundForUser(env)).toBe("[from planner] ping");
  });

  it("renders approval-request as [approval request from <peer>] <title>", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "abc12345-0000-0000-0000-000000000000",
      from: "supervisor",
      to: "worker-a",
      ts: 0,
      payload: { kind: "approval-request", title: "Review draft", summary: "3 files", preview: "..." },
    };
    expect(renderInboundForUser(env)).toBe("[approval request from supervisor] Review draft");
  });

  it("renders approval-result as [approval result from <peer>: approved]", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "abc12345-0000-0000-0000-000000000000",
      from: "supervisor",
      to: "worker-a",
      ts: 0,
      payload: { kind: "approval-result", approved: true },
    };
    expect(renderInboundForUser(env)).toBe("[approval result from supervisor: approved]");
  });

  it("renders approval-result as [approval result from <peer>: rejected] when approved is false", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "abc12345-0000-0000-0000-000000000000",
      from: "supervisor",
      to: "worker-a",
      ts: 0,
      payload: { kind: "approval-result", approved: false },
    };
    expect(renderInboundForUser(env)).toBe("[approval result from supervisor: rejected]");
  });

  it("renders revision-requested as [revise from <peer>] <note>", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "abc12345-0000-0000-0000-000000000000",
      from: "supervisor",
      to: "worker-a",
      ts: 0,
      payload: { kind: "revision-requested", note: "Add error handling" },
    };
    expect(renderInboundForUser(env)).toBe("[revise from supervisor] Add error handling");
  });

  it("renders submission as [submission from <peer>] <N> artifacts: <summary>", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "abc12345-0000-0000-0000-000000000000",
      from: "worker-a",
      to: "supervisor",
      ts: 0,
      payload: {
        kind: "submission",
        artifacts: [
          { kind: "write", relPath: "a.txt", content: "hi", sha256: "abc" },
          { kind: "delete", relPath: "b.txt", sha256: "def" },
        ],
        summary: "two changes",
      },
    };
    expect(renderInboundForUser(env)).toBe("[submission from worker-a] 2 artifacts: two changes");
  });

  it("renders submission without summary when summary is absent", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "abc12345-0000-0000-0000-000000000000",
      from: "worker-a",
      to: "supervisor",
      ts: 0,
      payload: {
        kind: "submission",
        artifacts: [{ kind: "write", relPath: "a.txt", content: "hi", sha256: "abc" }],
      },
    };
    expect(renderInboundForUser(env)).toBe("[submission from worker-a] 1 artifact");
  });

  it("formats with in_reply_to using an 8-char prefix", () => {
    const env: Envelope = {
      v: 2,
      msg_id: "def67890-0000-0000-0000-000000000000",
      from: "worker-a",
      to: "planner",
      ts: 0,
      payload: { kind: "message", text: "pong" },
      in_reply_to: "abc12345-0000-0000-0000-000000000000",
    };
    expect(renderInboundForUser(env)).toBe("[from worker-a re:abc12345] pong");
  });
});
