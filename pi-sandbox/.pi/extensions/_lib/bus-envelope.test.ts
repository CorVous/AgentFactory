import { describe, it, expect } from "vitest";
import {
  makeMessageEnvelope,
  makeApprovalRequestEnvelope,
  makeApprovalResultEnvelope,
  makeRevisionRequestedEnvelope,
  makeSubmissionEnvelope,
  encodeEnvelope,
  tryDecodeEnvelope,
  renderInboundForUser,
  type Artifact,
} from "./bus-envelope";

// ---------------------------------------------------------------------------
// makeMessageEnvelope
// ---------------------------------------------------------------------------

describe("makeMessageEnvelope", () => {
  it("sets v:2, a UUID msg_id, numeric ts, from/to/text, kind message", () => {
    const env = makeMessageEnvelope({ from: "planner", to: "worker", text: "hello" });
    expect(env.v).toBe(2);
    expect(env.msg_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof env.ts).toBe("number");
    expect(env.from).toBe("planner");
    expect(env.to).toBe("worker");
    expect(env.payload.kind).toBe("message");
    if (env.payload.kind === "message") expect(env.payload.text).toBe("hello");
  });

  it("carries in_reply_to when supplied", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "x", in_reply_to: "some-id" });
    expect(env.in_reply_to).toBe("some-id");
  });

  it("omits in_reply_to when not supplied", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "x" });
    expect(env.in_reply_to).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// encodeEnvelope / tryDecodeEnvelope — round-trip and malformed inputs
// ---------------------------------------------------------------------------

describe("encodeEnvelope + tryDecodeEnvelope", () => {
  it("round-trips a message envelope", () => {
    const env = makeMessageEnvelope({ from: "p", to: "w", text: "ping" });
    const decoded = tryDecodeEnvelope(encodeEnvelope(env));
    expect(decoded).toEqual(env);
  });

  it("encodeEnvelope produces a single line ending in \\n", () => {
    const env = makeMessageEnvelope({ from: "p", to: "w", text: "x" });
    const line = encodeEnvelope(env);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("returns null for non-JSON input", () => {
    expect(tryDecodeEnvelope("not json")).toBeNull();
  });

  it("returns null for wrong v", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "t" });
    const raw = JSON.stringify({ ...env, v: 1 });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when payload is missing", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "t" });
    const { payload: _p, ...rest } = env;
    expect(tryDecodeEnvelope(JSON.stringify(rest) + "\n")).toBeNull();
  });

  it("returns null for unknown payload kind", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "t" });
    const raw = JSON.stringify({ ...env, payload: { kind: "unknown", text: "t" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when message payload is missing text", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "t" });
    const raw = JSON.stringify({ ...env, payload: { kind: "message" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when message text is not a string", () => {
    const env = makeMessageEnvelope({ from: "a", to: "b", text: "t" });
    const raw = JSON.stringify({ ...env, payload: { kind: "message", text: 42 } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderInboundForUser — message kind
// ---------------------------------------------------------------------------

describe("renderInboundForUser (message)", () => {
  it("produces [from <peer>] <text>", () => {
    const env = makeMessageEnvelope({ from: "planner", to: "worker", text: "hello" });
    expect(renderInboundForUser(env)).toBe("[from planner] hello");
  });

  it("includes re:<8-char-prefix> when in_reply_to is set", () => {
    const env = makeMessageEnvelope({
      from: "planner",
      to: "worker",
      text: "pong",
      in_reply_to: "abcdef12-rest-of-uuid",
    });
    expect(renderInboundForUser(env)).toBe("[from planner re:abcdef12] pong");
  });
});

// ---------------------------------------------------------------------------
// makeApprovalRequestEnvelope
// ---------------------------------------------------------------------------

describe("makeApprovalRequestEnvelope", () => {
  it("builds an envelope with kind approval-request and required fields", () => {
    const env = makeApprovalRequestEnvelope({
      from: "worker",
      to: "supervisor",
      title: "Draft hello.txt",
      summary: "1 file",
      preview: "content...",
    });
    expect(env.payload.kind).toBe("approval-request");
    if (env.payload.kind === "approval-request") {
      expect(env.payload.title).toBe("Draft hello.txt");
      expect(env.payload.summary).toBe("1 file");
      expect(env.payload.preview).toBe("content...");
    }
    expect(env.in_reply_to).toBeUndefined();
  });

  it("carries in_reply_to when supplied", () => {
    const env = makeApprovalRequestEnvelope({
      from: "a",
      to: "b",
      title: "t",
      summary: "s",
      preview: "p",
      in_reply_to: "prior-id",
    });
    expect(env.in_reply_to).toBe("prior-id");
  });
});

// ---------------------------------------------------------------------------
// tryDecodeEnvelope — approval-request
// ---------------------------------------------------------------------------

describe("tryDecodeEnvelope (approval-request)", () => {
  it("accepts a valid approval-request envelope", () => {
    const env = makeApprovalRequestEnvelope({ from: "w", to: "s", title: "t", summary: "s", preview: "p" });
    expect(tryDecodeEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it("returns null when title is missing", () => {
    const env = makeApprovalRequestEnvelope({ from: "w", to: "s", title: "t", summary: "s", preview: "p" });
    const raw = JSON.stringify({ ...env, payload: { kind: "approval-request", summary: "s", preview: "p" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when summary is not a string", () => {
    const env = makeApprovalRequestEnvelope({ from: "w", to: "s", title: "t", summary: "s", preview: "p" });
    const raw = JSON.stringify({ ...env, payload: { kind: "approval-request", title: "t", summary: 99, preview: "p" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when preview is missing", () => {
    const env = makeApprovalRequestEnvelope({ from: "w", to: "s", title: "t", summary: "s", preview: "p" });
    const raw = JSON.stringify({ ...env, payload: { kind: "approval-request", title: "t", summary: "s" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderInboundForUser — approval-request
// ---------------------------------------------------------------------------

describe("renderInboundForUser (approval-request)", () => {
  it("produces [approval request from <peer>] <title>", () => {
    const env = makeApprovalRequestEnvelope({ from: "worker", to: "sup", title: "Draft hello.txt", summary: "1 file", preview: "..." });
    expect(renderInboundForUser(env)).toBe("[approval request from worker] Draft hello.txt");
  });
});

// ---------------------------------------------------------------------------
// makeApprovalResultEnvelope
// ---------------------------------------------------------------------------

describe("makeApprovalResultEnvelope", () => {
  it("builds an envelope with kind approval-result and approved flag", () => {
    const env = makeApprovalResultEnvelope({ from: "sup", to: "worker", in_reply_to: "req-id", approved: true });
    expect(env.payload.kind).toBe("approval-result");
    if (env.payload.kind === "approval-result") {
      expect(env.payload.approved).toBe(true);
      expect(env.payload.note).toBeUndefined();
    }
    expect(env.in_reply_to).toBe("req-id");
  });

  it("carries optional note", () => {
    const env = makeApprovalResultEnvelope({
      from: "sup",
      to: "worker",
      in_reply_to: "req-id",
      approved: false,
      note: "missing tests",
    });
    if (env.payload.kind === "approval-result") {
      expect(env.payload.approved).toBe(false);
      expect(env.payload.note).toBe("missing tests");
    }
  });
});

// ---------------------------------------------------------------------------
// tryDecodeEnvelope — approval-result
// ---------------------------------------------------------------------------

describe("tryDecodeEnvelope (approval-result)", () => {
  it("accepts a valid approval-result envelope", () => {
    const env = makeApprovalResultEnvelope({ from: "s", to: "w", in_reply_to: "id", approved: true });
    expect(tryDecodeEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it("returns null when approved is missing", () => {
    const env = makeApprovalResultEnvelope({ from: "s", to: "w", in_reply_to: "id", approved: true });
    const raw = JSON.stringify({ ...env, payload: { kind: "approval-result" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when approved is not a boolean", () => {
    const env = makeApprovalResultEnvelope({ from: "s", to: "w", in_reply_to: "id", approved: true });
    const raw = JSON.stringify({ ...env, payload: { kind: "approval-result", approved: "yes" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderInboundForUser — approval-result
// ---------------------------------------------------------------------------

describe("renderInboundForUser (approval-result)", () => {
  it("produces [approval result from <peer>: approved]", () => {
    const env = makeApprovalResultEnvelope({ from: "sup", to: "worker", in_reply_to: "id", approved: true });
    expect(renderInboundForUser(env)).toBe("[approval result from sup: approved]");
  });

  it("produces [approval result from <peer>: rejected]", () => {
    const env = makeApprovalResultEnvelope({ from: "sup", to: "worker", in_reply_to: "id", approved: false });
    expect(renderInboundForUser(env)).toBe("[approval result from sup: rejected]");
  });
});

// ---------------------------------------------------------------------------
// makeRevisionRequestedEnvelope
// ---------------------------------------------------------------------------

describe("makeRevisionRequestedEnvelope", () => {
  it("builds an envelope with kind revision-requested and required note", () => {
    const env = makeRevisionRequestedEnvelope({ from: "sup", to: "worker", in_reply_to: "req-id", note: "add tests" });
    expect(env.payload.kind).toBe("revision-requested");
    if (env.payload.kind === "revision-requested") {
      expect(env.payload.note).toBe("add tests");
    }
    expect(env.in_reply_to).toBe("req-id");
  });
});

// ---------------------------------------------------------------------------
// tryDecodeEnvelope — revision-requested
// ---------------------------------------------------------------------------

describe("tryDecodeEnvelope (revision-requested)", () => {
  it("accepts a valid revision-requested envelope", () => {
    const env = makeRevisionRequestedEnvelope({ from: "s", to: "w", in_reply_to: "id", note: "fix it" });
    expect(tryDecodeEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it("returns null when note is missing", () => {
    const env = makeRevisionRequestedEnvelope({ from: "s", to: "w", in_reply_to: "id", note: "fix it" });
    const raw = JSON.stringify({ ...env, payload: { kind: "revision-requested" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when note is not a string", () => {
    const env = makeRevisionRequestedEnvelope({ from: "s", to: "w", in_reply_to: "id", note: "fix it" });
    const raw = JSON.stringify({ ...env, payload: { kind: "revision-requested", note: 0 } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderInboundForUser — revision-requested
// ---------------------------------------------------------------------------

describe("renderInboundForUser (revision-requested)", () => {
  it("produces [revise from <peer>] <note>", () => {
    const env = makeRevisionRequestedEnvelope({ from: "sup", to: "worker", in_reply_to: "id", note: "add tests" });
    expect(renderInboundForUser(env)).toBe("[revise from sup] add tests");
  });
});

// ---------------------------------------------------------------------------
// makeSubmissionEnvelope
// ---------------------------------------------------------------------------

const WRITE_ARTIFACT: Artifact = {
  kind: "write",
  relPath: "hello.txt",
  content: "Hi",
  sha256: "abc123",
};

const EDIT_ARTIFACT: Artifact = {
  kind: "edit",
  relPath: "foo.ts",
  sha256OfOriginal: "def456",
  edits: [{ oldString: "foo", newString: "bar" }],
};

const MOVE_ARTIFACT: Artifact = {
  kind: "move",
  src: "a.txt",
  dst: "b.txt",
  sha256OfSource: "ghi789",
};

const DELETE_ARTIFACT: Artifact = {
  kind: "delete",
  relPath: "old.txt",
  sha256: "jkl012",
};

describe("makeSubmissionEnvelope", () => {
  it("builds an envelope with kind submission and artifacts array", () => {
    const env = makeSubmissionEnvelope({ from: "worker", to: "sup", artifacts: [WRITE_ARTIFACT] });
    expect(env.payload.kind).toBe("submission");
    if (env.payload.kind === "submission") {
      expect(env.payload.artifacts).toEqual([WRITE_ARTIFACT]);
      expect(env.payload.summary).toBeUndefined();
    }
  });

  it("carries optional summary", () => {
    const env = makeSubmissionEnvelope({
      from: "worker",
      to: "sup",
      artifacts: [WRITE_ARTIFACT, EDIT_ARTIFACT],
      summary: "2 changes",
    });
    if (env.payload.kind === "submission") {
      expect(env.payload.summary).toBe("2 changes");
    }
  });
});

// ---------------------------------------------------------------------------
// tryDecodeEnvelope — submission
// ---------------------------------------------------------------------------

describe("tryDecodeEnvelope (submission)", () => {
  it("accepts a valid submission with all four artifact kinds", () => {
    const env = makeSubmissionEnvelope({
      from: "w",
      to: "s",
      artifacts: [WRITE_ARTIFACT, EDIT_ARTIFACT, MOVE_ARTIFACT, DELETE_ARTIFACT],
      summary: "4 ops",
    });
    expect(tryDecodeEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it("returns null when artifacts is missing", () => {
    const env = makeSubmissionEnvelope({ from: "w", to: "s", artifacts: [WRITE_ARTIFACT] });
    const raw = JSON.stringify({ ...env, payload: { kind: "submission" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when artifacts is not an array", () => {
    const env = makeSubmissionEnvelope({ from: "w", to: "s", artifacts: [WRITE_ARTIFACT] });
    const raw = JSON.stringify({ ...env, payload: { kind: "submission", artifacts: "bad" } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when an artifact has an unknown kind", () => {
    const env = makeSubmissionEnvelope({ from: "w", to: "s", artifacts: [WRITE_ARTIFACT] });
    const raw = JSON.stringify({
      ...env,
      payload: { kind: "submission", artifacts: [{ kind: "unknown", relPath: "x" }] },
    });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when a write artifact is missing relPath", () => {
    const env = makeSubmissionEnvelope({ from: "w", to: "s", artifacts: [WRITE_ARTIFACT] });
    const { relPath: _rp, ...badArtifact } = WRITE_ARTIFACT;
    const raw = JSON.stringify({ ...env, payload: { kind: "submission", artifacts: [badArtifact] } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });

  it("returns null when a move artifact is missing src", () => {
    const env = makeSubmissionEnvelope({ from: "w", to: "s", artifacts: [MOVE_ARTIFACT] });
    const { src: _s, ...badArtifact } = MOVE_ARTIFACT;
    const raw = JSON.stringify({ ...env, payload: { kind: "submission", artifacts: [badArtifact] } });
    expect(tryDecodeEnvelope(raw + "\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderInboundForUser — submission
// ---------------------------------------------------------------------------

describe("renderInboundForUser (submission)", () => {
  it("produces [submission from <peer>] <N> artifacts: <summary>", () => {
    const env = makeSubmissionEnvelope({
      from: "worker",
      to: "sup",
      artifacts: [WRITE_ARTIFACT, EDIT_ARTIFACT],
      summary: "2 changes",
    });
    expect(renderInboundForUser(env)).toBe("[submission from worker] 2 artifacts: 2 changes");
  });

  it("omits the summary suffix when summary is absent", () => {
    const env = makeSubmissionEnvelope({ from: "worker", to: "sup", artifacts: [WRITE_ARTIFACT] });
    expect(renderInboundForUser(env)).toBe("[submission from worker] 1 artifacts");
  });
});
