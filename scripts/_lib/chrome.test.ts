/**
 * chrome.test.ts — hermetic unit tests for right-rail ANSI rendering.
 *
 * Contract: no I/O, no network. Rendering is deterministic for fixed input.
 * ANSI sequences are verified to be present/absent via helpers; plain text
 * content is verified after stripping ANSI.
 */

import { describe, it, expect } from "vitest";
import { renderChrome, renderPeerRow, renderDecisionsPanel, stripAnsi } from "./chrome.mjs";

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    expect(stripAnsi("\x1b[32m●\x1b[0m")).toBe("●");
    expect(stripAnsi("\x1b[1m\x1b[36mMesh\x1b[0m")).toBe("Mesh");
  });

  it("leaves plain strings unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

describe("renderChrome — header", () => {
  it("includes mesh title", () => {
    const output = renderChrome({ peers: [], focused: null, meshName: "test-mesh" });
    expect(stripAnsi(output)).toContain("Mesh: test-mesh");
  });

  it("defaults to 'Mesh' when meshName is not provided", () => {
    const output = renderChrome({ peers: [], focused: null });
    expect(stripAnsi(output)).toContain("Mesh");
  });

  it("includes busRoot in header", () => {
    const output = renderChrome({ peers: [], focused: null, busRoot: "/tmp/my-bus" });
    expect(stripAnsi(output)).toContain("bus:");
    expect(stripAnsi(output)).toContain("/tmp/my-bus");
  });

  it("truncates long busRoot", () => {
    const longPath = "/very/long/path/that/exceeds/thirty/characters/for/bus";
    const output = renderChrome({ peers: [], focused: null, busRoot: longPath });
    expect(stripAnsi(output)).toContain("…");
  });

  it("shows correct peer count", () => {
    const output = renderChrome({
      peers: [
        { name: "peer-a", state: "running" },
        { name: "peer-b", state: "spawning" },
      ],
      focused: null,
    });
    expect(stripAnsi(output)).toContain("2 peers");
  });

  it("uses singular 'peer' for 1 peer", () => {
    const output = renderChrome({
      peers: [{ name: "peer-a", state: "running" }],
      focused: null,
    });
    expect(stripAnsi(output)).toContain("1 peer");
    expect(stripAnsi(output)).not.toContain("1 peers");
  });
});

describe("renderChrome — peer rows", () => {
  it("shows each peer name", () => {
    const output = renderChrome({
      peers: [
        { name: "peer-a", state: "running" },
        { name: "peer-b", state: "exited" },
      ],
      focused: "peer-a",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("peer-a");
    expect(plain).toContain("peer-b");
  });

  it("marks focused peer with ▶", () => {
    const output = renderChrome({
      peers: [
        { name: "peer-a", state: "running" },
        { name: "peer-b", state: "running" },
      ],
      focused: "peer-a",
    });
    const plain = stripAnsi(output);
    const lines = plain.split("\n").filter(Boolean);
    const focusedLine = lines.find((l) => l.includes("peer-a"));
    const unfocusedLine = lines.find((l) => l.includes("peer-b"));
    expect(focusedLine).toContain("▶");
    expect(unfocusedLine).not.toContain("▶");
  });

  it("shows state icon ● for running", () => {
    const output = renderChrome({
      peers: [{ name: "peer-a", state: "running" }],
      focused: null,
    });
    expect(stripAnsi(output)).toContain("●");
  });

  it("shows state icon ○ for spawning", () => {
    const output = renderChrome({
      peers: [{ name: "peer-a", state: "spawning" }],
      focused: null,
    });
    expect(stripAnsi(output)).toContain("○");
  });

  it("shows state icon ✗ for exited", () => {
    const output = renderChrome({
      peers: [{ name: "peer-a", state: "exited" }],
      focused: null,
    });
    expect(stripAnsi(output)).toContain("✗");
  });

  it("handles empty peer list gracefully", () => {
    const output = renderChrome({ peers: [], focused: null });
    expect(typeof output).toBe("string");
    expect(stripAnsi(output)).toContain("0 peers");
  });
});

describe("renderPeerRow", () => {
  it("marks focused peer", () => {
    const row = renderPeerRow({ name: "peer-a", state: "running" }, true);
    expect(stripAnsi(row)).toContain("▶");
    expect(stripAnsi(row)).toContain("peer-a");
  });

  it("does not mark unfocused peer", () => {
    const row = renderPeerRow({ name: "peer-b", state: "running" }, false);
    expect(stripAnsi(row)).not.toContain("▶");
    expect(stripAnsi(row)).toContain("peer-b");
  });

  it("shows correct icon for each state", () => {
    const states = [
      ["running", "●"],
      ["spawning", "○"],
      ["exited", "✗"],
      ["exiting", "↓"],
      ["unknown", "?"],
    ] as const;
    for (const [state, icon] of states) {
      const row = renderPeerRow({ name: "p", state: state as any }, false);
      expect(stripAnsi(row)).toContain(icon);
    }
  });
});

describe("renderChrome — output format", () => {
  it("is a multi-line string terminated with newline", () => {
    const output = renderChrome({ peers: [], focused: null });
    expect(output.endsWith("\n")).toBe(true);
    expect(output.split("\n").length).toBeGreaterThan(1);
  });

  it("is deterministic for the same input", () => {
    const opts = {
      peers: [
        { name: "alpha", state: "running" as const },
        { name: "beta", state: "exited" as const },
      ],
      focused: "alpha",
      busRoot: "/tmp/bus",
      meshName: "test",
    };
    expect(renderChrome(opts)).toBe(renderChrome(opts));
  });
});

// ── crashed peer state ────────────────────────────────────────────────────────

describe("renderPeerRow — crashed state", () => {
  it("shows state icon ✗ (bold red) for crashed", () => {
    const row = renderPeerRow({ name: "peer-a", state: "crashed" }, false);
    expect(stripAnsi(row)).toContain("✗");
    expect(stripAnsi(row)).toContain("peer-a");
  });

  it("shows exit code in parentheses for crashed peer with exitCode", () => {
    const row = renderPeerRow({ name: "peer-a", state: "crashed", exitCode: 1, exitSignal: null }, false);
    expect(stripAnsi(row)).toContain("exit=1");
    expect(stripAnsi(row)).toContain("peer-a");
  });

  it("shows SIG<name> when killed by signal", () => {
    const row = renderPeerRow({ name: "peer-a", state: "crashed", exitCode: null, exitSignal: "KILL" }, false);
    expect(stripAnsi(row)).toContain("SIGKILL");
    expect(stripAnsi(row)).toContain("peer-a");
  });

  it("shows 'crashed' fallback when no code or signal", () => {
    const row = renderPeerRow({ name: "peer-a", state: "crashed" }, false);
    expect(stripAnsi(row)).toContain("crashed");
  });

  it("shows exit code when focused", () => {
    const row = renderPeerRow({ name: "peer-a", state: "crashed", exitCode: 2, exitSignal: null }, true);
    const plain = stripAnsi(row);
    expect(plain).toContain("▶");
    expect(plain).toContain("exit=2");
  });
});

describe("renderChrome — crashed peer in peers list", () => {
  it("renders crashed peer with exit code in the peers list", () => {
    const output = renderChrome({
      peers: [
        { name: "entry", state: "crashed", exitCode: 1, exitSignal: null },
        { name: "supervisor", state: "running" },
      ],
      focused: "supervisor",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("entry");
    expect(plain).toContain("exit=1");
    expect(plain).toContain("✗");
  });
});

// ── decisions pending badge ───────────────────────────────────────────────────

describe("renderPeerRow — decisions pending badge", () => {
  it("shows 'decisions pending' badge for non-focused peer with decisionPending:true", () => {
    const row = renderPeerRow({ name: "authority", state: "running", decisionPending: true }, false);
    expect(stripAnsi(row)).toContain("decisions pending");
    expect(stripAnsi(row)).toContain("authority");
  });

  it("does NOT show badge for focused peer even when decisionPending:true", () => {
    // Focused peer shows the dialog itself; badge is unnecessary.
    const row = renderPeerRow({ name: "authority", state: "running", decisionPending: true }, true);
    expect(stripAnsi(row)).not.toContain("decisions pending");
    expect(stripAnsi(row)).toContain("▶");
  });

  it("does NOT show badge when decisionPending is false", () => {
    const row = renderPeerRow({ name: "authority", state: "running", decisionPending: false }, false);
    expect(stripAnsi(row)).not.toContain("decisions pending");
  });

  it("does NOT show badge when decisionPending is undefined", () => {
    const row = renderPeerRow({ name: "authority", state: "running" }, false);
    expect(stripAnsi(row)).not.toContain("decisions pending");
  });
});

describe("renderChrome — decisions pending badge in peer list", () => {
  it("shows badge for non-focused peer with pending decision", () => {
    const output = renderChrome({
      peers: [
        { name: "authority", state: "running", decisionPending: true },
        { name: "worker", state: "running" },
      ],
      focused: "worker",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("decisions pending");
    expect(plain).toContain("authority");
  });

  it("does NOT show badge for the focused peer even if decisionPending is set", () => {
    const output = renderChrome({
      peers: [
        { name: "authority", state: "running", decisionPending: true },
        { name: "worker", state: "running" },
      ],
      focused: "authority",
    });
    const plain = stripAnsi(output);
    // Badge should not appear when that peer IS focused
    const lines = plain.split("\n").filter(Boolean);
    const authorityLine = lines.find((l) => l.includes("authority"));
    expect(authorityLine).toBeDefined();
    expect(authorityLine).not.toContain("decisions pending");
  });

  it("shows no badge when no peer has decisionPending set", () => {
    const output = renderChrome({
      peers: [
        { name: "authority", state: "running" },
        { name: "worker", state: "running" },
      ],
      focused: "worker",
    });
    expect(stripAnsi(output)).not.toContain("decisions pending");
  });
});

// ── auto-shift notice ─────────────────────────────────────────────────────────

describe("renderChrome — auto-shift notice", () => {
  it("renders the notice when autoShiftNotice is set", () => {
    const output = renderChrome({
      peers: [{ name: "supervisor", state: "running" }],
      focused: "supervisor",
      autoShiftNotice: 'entry peer "entry" exited; focus moved to "supervisor"',
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("entry");
    expect(plain).toContain("supervisor");
    expect(plain).toContain("focus moved");
  });

  it("does not render notice section when autoShiftNotice is null", () => {
    const output = renderChrome({
      peers: [{ name: "supervisor", state: "running" }],
      focused: "supervisor",
      autoShiftNotice: null,
    });
    const plain = stripAnsi(output);
    expect(plain).not.toContain("focus moved");
  });

  it("does not render notice section when autoShiftNotice is undefined", () => {
    const output = renderChrome({
      peers: [{ name: "supervisor", state: "running" }],
      focused: "supervisor",
    });
    const plain = stripAnsi(output);
    expect(plain).not.toContain("focus moved");
  });

  it("shows ! marker in the notice", () => {
    const output = renderChrome({
      peers: [],
      focused: null,
      autoShiftNotice: "top supervisor crashed; no peer to shift focus to",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("!");
    expect(plain).toContain("top supervisor");
  });
});

// ── decisions queue panel ─────────────────────────────────────────────────────

const BASE_TS = 1_700_000_000_000; // fixed epoch ms for deterministic age tests

describe("renderDecisionsPanel — empty queue", () => {
  it("shows 'Decisions' header and (none) for empty queue", () => {
    const lines = renderDecisionsPanel([], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("Decisions");
    expect(plain).toContain("(none)");
  });

  it("does NOT show count badge for empty queue", () => {
    const lines = renderDecisionsPanel([], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).not.toMatch(/\[\d+\]/);
  });
});

describe("renderDecisionsPanel — non-empty queue", () => {
  const item = {
    msg_id: "msg-1",
    peer: "authority",
    kind: "approval-request",
    summary: "approve build step",
    ts: BASE_TS - 90_000, // 1.5 minutes ago
    pinned: true,
  };

  it("shows peer name, kind, summary, and age", () => {
    const lines = renderDecisionsPanel([item], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("authority");
    expect(plain).toContain("approve");
    expect(plain).toContain("approve build step");
    expect(plain).toContain("ago");
  });

  it("shows count badge in header for non-empty queue", () => {
    const lines = renderDecisionsPanel([item], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toMatch(/\[1\]/);
  });

  it("shows pinned star icon for pinned items", () => {
    const lines = renderDecisionsPanel([item], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("★");
  });

  it("does NOT show star icon for non-pinned items", () => {
    const nonPinned = { ...item, pinned: false };
    const lines = renderDecisionsPanel([nonPinned], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).not.toContain("★");
  });

  it("truncates long summaries to 30 chars with ellipsis", () => {
    const longSummary = "a".repeat(50);
    const longItem = { ...item, summary: longSummary };
    const lines = renderDecisionsPanel([longItem], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("…");
    // The truncated text should not contain the full 50 chars
    expect(plain).not.toContain("a".repeat(40));
  });

  it("shows correct count in badge for multiple items", () => {
    const items = [
      { ...item, msg_id: "a" },
      { ...item, msg_id: "b" },
      { ...item, msg_id: "c" },
    ];
    const lines = renderDecisionsPanel(items, BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toMatch(/\[3\]/);
  });

  it("formats age as 'just now' for recent items", () => {
    const recentItem = { ...item, ts: BASE_TS - 10_000 }; // 10 seconds ago
    const lines = renderDecisionsPanel([recentItem], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("just now");
  });

  it("formats age as Xm ago for minute-range items", () => {
    const minuteItem = { ...item, ts: BASE_TS - 5 * 60_000 }; // 5 minutes ago
    const lines = renderDecisionsPanel([minuteItem], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("5m ago");
  });

  it("formats age as Xh ago for hour-range items", () => {
    const hourItem = { ...item, ts: BASE_TS - 2 * 3_600_000 }; // 2 hours ago
    const lines = renderDecisionsPanel([hourItem], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("2h ago");
  });

  it("abbreviates 'submission' kind to 'submit'", () => {
    const submissionItem = { ...item, kind: "submission" };
    const lines = renderDecisionsPanel([submissionItem], BASE_TS);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("submit");
  });
});

describe("renderChrome — decisions queue panel integration", () => {
  const item = {
    msg_id: "msg-1",
    peer: "authority",
    kind: "approval-request",
    summary: "approve build",
    ts: Date.now() - 30_000,
    pinned: true,
  };

  it("renders decisions panel under peers list when decisionsQueue is provided", () => {
    const output = renderChrome({
      peers: [{ name: "authority", state: "running" }],
      focused: "authority",
      decisionsQueue: [item],
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("Decisions");
    expect(plain).toContain("authority");
  });

  it("does NOT render decisions panel when decisionsQueue is undefined", () => {
    const output = renderChrome({
      peers: [{ name: "authority", state: "running" }],
      focused: "authority",
    });
    const plain = stripAnsi(output);
    expect(plain).not.toContain("Decisions");
  });

  it("shows count badge in header when decisionsQueue is non-empty", () => {
    const output = renderChrome({
      peers: [{ name: "authority", state: "running" }],
      focused: "authority",
      decisionsQueue: [item],
    });
    const plain = stripAnsi(output);
    // Header line should contain [1] badge
    const headerLine = plain.split("\n")[0];
    expect(headerLine).toContain("[1]");
  });

  it("does NOT show count badge in header when decisionsQueue is empty", () => {
    const output = renderChrome({
      peers: [],
      focused: null,
      decisionsQueue: [],
    });
    const headerLine = stripAnsi(output).split("\n")[0];
    expect(headerLine).not.toMatch(/\[\d+\]/);
  });

  it("shows (none) in decisions panel when queue is empty", () => {
    const output = renderChrome({
      peers: [],
      focused: null,
      decisionsQueue: [],
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("Decisions");
    expect(plain).toContain("(none)");
  });

  it("decisions panel appears after peers list", () => {
    const output = renderChrome({
      peers: [{ name: "peer-a", state: "running" }],
      focused: "peer-a",
      decisionsQueue: [item],
    });
    const plain = stripAnsi(output);
    const peerIdx = plain.indexOf("peer-a");
    const decisionsIdx = plain.indexOf("Decisions");
    expect(peerIdx).toBeLessThan(decisionsIdx);
  });
});
