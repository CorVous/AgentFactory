// Tests for the supervisor inbound rail:
//   - getSupervisorInbox / dispatchToSupervisor (the testable core)
//   - respond_to_request action routing (approve/reject/revise/escalate)
//   - acceptedFrom enforcement
//   - revision cap (max 3 revisions per msg_id chain)
//
// The supervisor rail is implemented in supervisor.ts but exposes its
// core logic through _lib/supervisor-inbox.ts for testability.

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setHabitat, type Habitat } from "./habitat";
import {
  createSupervisorInbox,
  type SupervisorInbox,
  type InboundEnvelope,
} from "./supervisor-inbox";
import {
  makeApprovalRequestEnvelope,
  makeSubmissionEnvelope,
  type Artifact,
} from "./bus-envelope";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const BASE_HABITAT: Habitat = {
  agentName: "supervisor",
  scratchRoot: "/tmp/scratch",
  busRoot: "/tmp/bus",
  skills: [],
  agents: [],
  noEditAdd: [],
  noEditSkip: [],
  acceptedFrom: ["worker-a", "worker-b"],
  peers: [],
  supervisor: undefined,
  submitTo: undefined,
};

const WRITE_ARTIFACT: Artifact = {
  kind: "write",
  relPath: "hello.txt",
  content: "Hi",
  sha256: "abc123",
};

beforeEach(() => {
  (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__ = undefined;
});

// ---------------------------------------------------------------------------
// createSupervisorInbox
// ---------------------------------------------------------------------------

describe("createSupervisorInbox", () => {
  it("returns an inbox with an empty pending map", () => {
    const inbox = createSupervisorInbox();
    expect(inbox.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dispatchEnvelope — acceptedFrom enforcement
// ---------------------------------------------------------------------------

describe("dispatchEnvelope — acceptedFrom", () => {
  it("queues an approval-request from a peer in acceptedFrom", () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "Review draft",
      summary: "3 files",
      preview: "...",
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sendMessage = vi.fn();
    inbox.dispatchEnvelope(env, sendMessage);
    stderrSpy.mockRestore();
    expect(inbox.pendingCount()).toBe(1);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("drops an approval-request from a peer NOT in acceptedFrom (silently)", () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "unknown-peer",
      to: "supervisor",
      title: "Sneaky request",
      summary: "s",
      preview: "p",
    });
    const sendMessage = vi.fn();
    inbox.dispatchEnvelope(env, sendMessage);
    expect(inbox.pendingCount()).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("logs a debug message to stderr when dropping from unknown peer (AGENT_DEBUG=1)", () => {
    process.env.AGENT_DEBUG = "1";
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "intruder",
      to: "supervisor",
      title: "x",
      summary: "s",
      preview: "p",
    });
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderrLines.push(String(s));
      return true;
    });
    inbox.dispatchEnvelope(env, vi.fn());
    stderrSpy.mockRestore();
    delete process.env.AGENT_DEBUG;
    expect(stderrLines.some((l) => l.includes("intruder"))).toBe(true);
  });

  it("queues a submission from any peer in acceptedFrom", () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeSubmissionEnvelope({
      from: "worker-b",
      to: "supervisor",
      artifacts: [WRITE_ARTIFACT],
      summary: "one file",
    });
    const sendMessage = vi.fn();
    inbox.dispatchEnvelope(env, sendMessage);
    expect(inbox.pendingCount()).toBe(1);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("drops a submission from a peer NOT in acceptedFrom", () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeSubmissionEnvelope({
      from: "rogue-agent",
      to: "supervisor",
      artifacts: [WRITE_ARTIFACT],
    });
    const sendMessage = vi.fn();
    inbox.dispatchEnvelope(env, sendMessage);
    expect(inbox.pendingCount()).toBe(0);
  });

  it("passes when acceptedFrom is empty (no peers allowed)", () => {
    setHabitat({ ...BASE_HABITAT, acceptedFrom: [] });
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "x",
      summary: "s",
      preview: "p",
    });
    const sendMessage = vi.fn();
    inbox.dispatchEnvelope(env, sendMessage);
    expect(inbox.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dispatchEnvelope — sendUserMessage rendering
// ---------------------------------------------------------------------------

describe("dispatchEnvelope — user message rendering", () => {
  it("calls sendMessage with a rendered string for approval-request", () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "Review my draft",
      summary: "s",
      preview: "p",
    });
    const sendMessage = vi.fn();
    inbox.dispatchEnvelope(env, sendMessage);
    const [msgId, rendered] = sendMessage.mock.calls[0] as [string, string];
    expect(msgId).toBe(env.msg_id);
    expect(rendered).toContain("worker-a");
    expect(rendered).toContain("Review my draft");
  });

  it("calls sendMessage with a rendered string for submission", () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeSubmissionEnvelope({
      from: "worker-a",
      to: "supervisor",
      artifacts: [WRITE_ARTIFACT],
      summary: "Created hello.txt",
    });
    const sendMessage = vi.fn();
    inbox.dispatchEnvelope(env, sendMessage);
    const [, rendered] = sendMessage.mock.calls[0] as [string, string];
    expect(rendered).toContain("worker-a");
    expect(rendered).toContain("Created hello.txt");
  });
});

// ---------------------------------------------------------------------------
// respondToRequest — approve action
// ---------------------------------------------------------------------------

describe("respondToRequest — approve", () => {
  it("builds and sends an approval-result(approved:true) back to the original sender", async () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "T",
      summary: "S",
      preview: "P",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn().mockResolvedValue({ delivered: true });
    const result = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "approve",
      sendEnvelope,
      agentName: "supervisor",
    });
    expect(result.ok).toBe(true);
    expect(sendEnvelope).toHaveBeenCalledOnce();
    const [sent] = sendEnvelope.mock.calls[0] as [InboundEnvelope];
    expect(sent.to).toBe("worker-a");
    expect(sent.payload.kind).toBe("approval-result");
    if (sent.payload.kind === "approval-result") {
      expect(sent.payload.approved).toBe(true);
    }
    // Message is cleared from pending after response
    expect(inbox.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// respondToRequest — approve action on submission (apply path)
// ---------------------------------------------------------------------------

describe("respondToRequest — approve on submission", () => {
  it("applies write artifact to scratchRoot and sends approved:true", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "supervisor-inbox-test-"));
    setHabitat({ ...BASE_HABITAT, scratchRoot });
    const inbox = createSupervisorInbox();

    const content = "Hello from worker\n";
    const artifact: Artifact = {
      kind: "write",
      relPath: "hello.txt",
      content,
      sha256: sha256(content),
    };
    const env = makeSubmissionEnvelope({
      from: "worker-a",
      to: "supervisor",
      artifacts: [artifact],
      summary: "write hello.txt",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn().mockResolvedValue({ delivered: true });
    const result = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "approve",
      sendEnvelope,
      agentName: "supervisor",
    });

    expect(result.ok).toBe(true);
    // File was actually written to the canonical root
    expect(existsSync(join(scratchRoot, "hello.txt"))).toBe(true);
    expect(readFileSync(join(scratchRoot, "hello.txt"), "utf8")).toBe(content);
    // Reply sent with approved:true
    expect(sendEnvelope).toHaveBeenCalledOnce();
    const [sent] = sendEnvelope.mock.calls[0] as [InboundEnvelope];
    expect(sent.payload.kind).toBe("approval-result");
    if (sent.payload.kind === "approval-result") {
      expect(sent.payload.approved).toBe(true);
    }
    expect(inbox.pendingCount()).toBe(0);
  });

  it("sends approved:false (with error note) when SHA mismatch; no fs change", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "supervisor-inbox-test-"));
    const originalContent = "original\n";
    writeFileSync(join(scratchRoot, "target.txt"), originalContent, "utf8");

    setHabitat({ ...BASE_HABITAT, scratchRoot });
    const inbox = createSupervisorInbox();

    const artifact: Artifact = {
      kind: "edit",
      relPath: "target.txt",
      sha256OfOriginal: "wrong-sha-entirely",
      edits: [{ oldString: "original", newString: "modified" }],
    };
    const env = makeSubmissionEnvelope({
      from: "worker-a",
      to: "supervisor",
      artifacts: [artifact],
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn().mockResolvedValue({ delivered: true });
    const result = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "approve",
      sendEnvelope,
      agentName: "supervisor",
    });

    expect(result.ok).toBe(true);
    // File must be unchanged
    expect(readFileSync(join(scratchRoot, "target.txt"), "utf8")).toBe(originalContent);
    // Reply sent with approved:false and an error note
    expect(sendEnvelope).toHaveBeenCalledOnce();
    const [sent] = sendEnvelope.mock.calls[0] as [InboundEnvelope];
    expect(sent.payload.kind).toBe("approval-result");
    if (sent.payload.kind === "approval-result") {
      expect(sent.payload.approved).toBe(false);
      expect(sent.payload.note).toMatch(/apply failed/i);
    }
    expect(inbox.pendingCount()).toBe(0);
  });

  it("approve on approval-request (not a submission) does NOT write to fs", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "supervisor-inbox-test-"));
    setHabitat({ ...BASE_HABITAT, scratchRoot });
    const inbox = createSupervisorInbox();

    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "T",
      summary: "S",
      preview: "P",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn().mockResolvedValue({ delivered: true });
    const result = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "approve",
      sendEnvelope,
      agentName: "supervisor",
    });

    expect(result.ok).toBe(true);
    const [sent] = sendEnvelope.mock.calls[0] as [InboundEnvelope];
    expect(sent.payload.kind).toBe("approval-result");
    if (sent.payload.kind === "approval-result") {
      expect(sent.payload.approved).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// respondToRequest — reject action
// ---------------------------------------------------------------------------

describe("respondToRequest — reject", () => {
  it("builds and sends an approval-result(approved:false) back to the sender", async () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "T",
      summary: "S",
      preview: "P",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn().mockResolvedValue({ delivered: true });
    const result = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "reject",
      note: "Not acceptable",
      sendEnvelope,
      agentName: "supervisor",
    });
    expect(result.ok).toBe(true);
    const [sent] = sendEnvelope.mock.calls[0] as [InboundEnvelope];
    expect(sent.payload.kind).toBe("approval-result");
    if (sent.payload.kind === "approval-result") {
      expect(sent.payload.approved).toBe(false);
      expect(sent.payload.note).toBe("Not acceptable");
    }
    expect(inbox.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// respondToRequest — revise action
// ---------------------------------------------------------------------------

describe("respondToRequest — revise", () => {
  it("builds and sends a revision-requested envelope with the note", async () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "T",
      summary: "S",
      preview: "P",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn().mockResolvedValue({ delivered: true });
    const result = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "revise",
      note: "Please fix the error handling",
      sendEnvelope,
      agentName: "supervisor",
    });
    expect(result.ok).toBe(true);
    const [sent] = sendEnvelope.mock.calls[0] as [InboundEnvelope];
    expect(sent.to).toBe("worker-a");
    expect(sent.payload.kind).toBe("revision-requested");
    if (sent.payload.kind === "revision-requested") {
      expect(sent.payload.note).toBe("Please fix the error handling");
    }
    // Message stays in pending after revise (worker can re-submit)
    expect(inbox.pendingCount()).toBe(1);
  });

  it("requires a note for revise", async () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "T",
      summary: "S",
      preview: "P",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn();
    const result = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "revise",
      sendEnvelope,
      agentName: "supervisor",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/note.*required/i);
    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it("caps revisions at 3 per msg_id chain; on cap, revise is rejected", async () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    let env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "T",
      summary: "S",
      preview: "P",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn().mockResolvedValue({ delivered: true });

    // Three successful revisions
    for (let i = 0; i < 3; i++) {
      const r = await inbox.respondToRequest({
        msg_id: env.msg_id,
        action: "revise",
        note: `Round ${i + 1}`,
        sendEnvelope,
        agentName: "supervisor",
      });
      expect(r.ok).toBe(true);
      // Simulate worker re-submitting on the same thread
      const resubmit = makeApprovalRequestEnvelope({
        from: "worker-a",
        to: "supervisor",
        title: "T",
        summary: "S",
        preview: "P",
      });
      // Link re-submission to original thread (same root msg_id)
      inbox.updatePendingMsgId(env.msg_id, resubmit.msg_id, resubmit);
      env = resubmit;
    }

    // 4th revise should be rejected (cap exceeded)
    const r4 = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "revise",
      note: "Round 4",
      sendEnvelope,
      agentName: "supervisor",
    });
    expect(r4.ok).toBe(false);
    expect(r4.error).toMatch(/revision.*cap/i);
  });
});

// ---------------------------------------------------------------------------
// respondToRequest — escalate action
// ---------------------------------------------------------------------------

describe("respondToRequest — escalate", () => {
  it("returns error when no supervisor is configured", async () => {
    setHabitat({ ...BASE_HABITAT, supervisor: undefined });
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "T",
      summary: "S",
      preview: "P",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn();
    const escalateToSupervisor = vi.fn();
    const result = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "escalate",
      sendEnvelope,
      agentName: "supervisor",
      escalateToSupervisor,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no supervisor/i);
    expect(escalateToSupervisor).not.toHaveBeenCalled();
  });

  it("forwards to supervisor and relays the upstream result back to original sender", async () => {
    setHabitat({ ...BASE_HABITAT, supervisor: "lead-hare" });
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "Needs escalation",
      summary: "S",
      preview: "P",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn().mockResolvedValue({ delivered: true });
    // escalateToSupervisor simulates an upstream approved:true response
    const escalateToSupervisor = vi.fn().mockResolvedValue({ approved: true, note: "OK" });

    const result = await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "escalate",
      sendEnvelope,
      agentName: "supervisor",
      escalateToSupervisor,
    });
    expect(result.ok).toBe(true);
    expect(escalateToSupervisor).toHaveBeenCalledWith(
      "lead-hare",
      expect.objectContaining({ title: "Needs escalation" }),
    );
    // Should relay the upstream result back to the original sender
    expect(sendEnvelope).toHaveBeenCalledOnce();
    const [sent] = sendEnvelope.mock.calls[0] as [InboundEnvelope];
    expect(sent.to).toBe("worker-a");
    expect(sent.payload.kind).toBe("approval-result");
    if (sent.payload.kind === "approval-result") {
      expect(sent.payload.approved).toBe(true);
    }
    expect(inbox.pendingCount()).toBe(0);
  });

  it("relays approved:false when upstream rejects", async () => {
    setHabitat({ ...BASE_HABITAT, supervisor: "lead-hare" });
    const inbox = createSupervisorInbox();
    const env = makeApprovalRequestEnvelope({
      from: "worker-a",
      to: "supervisor",
      title: "T",
      summary: "S",
      preview: "P",
    });
    inbox.dispatchEnvelope(env, vi.fn());

    const sendEnvelope = vi.fn().mockResolvedValue({ delivered: true });
    const escalateToSupervisor = vi.fn().mockResolvedValue({ approved: false, note: "Denied" });

    await inbox.respondToRequest({
      msg_id: env.msg_id,
      action: "escalate",
      sendEnvelope,
      agentName: "supervisor",
      escalateToSupervisor,
    });

    const [sent] = sendEnvelope.mock.calls[0] as [InboundEnvelope];
    if (sent.payload.kind === "approval-result") {
      expect(sent.payload.approved).toBe(false);
      expect(sent.payload.note).toBe("Denied");
    }
  });
});

// ---------------------------------------------------------------------------
// respondToRequest — unknown msg_id
// ---------------------------------------------------------------------------

describe("respondToRequest — unknown msg_id", () => {
  it("returns error for an unknown msg_id", async () => {
    setHabitat(BASE_HABITAT);
    const inbox = createSupervisorInbox();
    const sendEnvelope = vi.fn();
    const result = await inbox.respondToRequest({
      msg_id: "nonexistent-id",
      action: "approve",
      sendEnvelope,
      agentName: "supervisor",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(sendEnvelope).not.toHaveBeenCalled();
  });
});
