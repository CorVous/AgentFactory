/**
 * chrome.test.ts — hermetic unit tests for right-rail ANSI rendering.
 *
 * Contract: no I/O, no network. Rendering is deterministic for fixed input.
 * ANSI sequences are verified to be present/absent via helpers; plain text
 * content is verified after stripping ANSI.
 */

import { describe, it, expect } from "vitest";
import { renderChrome, renderPeerRow, stripAnsi } from "./chrome.mjs";

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
