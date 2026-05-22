// initial-mesh-validator.test.ts — hermetic unit tests for the pure
// validateInitialMesh function (packages/engine/agent/lib/initial-mesh-validator.ts).
//
// Contract: no I/O, no network, no real filesystem. recipeExists is injected.

import { describe, it, expect } from "vitest";
import { validateInitialMesh } from "./initial-mesh-validator.js";

// Helper: always says recipe file exists
const recipeAlwaysExists = (_: string) => true;

// Helper: always says recipe file does NOT exist
const recipeNeverExists = (_: string) => false;

// ── Valid cases ───────────────────────────────────────────────────────────────

describe("validateInitialMesh — valid entries", () => {
  it("passes a single minimal entry", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node" }],
      ["mesh-node", "mesh-writer"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });

  it("passes multiple entries with distinct explicit names", () => {
    const { errors } = validateInitialMesh(
      [
        { recipe: "mesh-node", name: "analyst" },
        { recipe: "mesh-writer", name: "scribe" },
      ],
      ["mesh-node", "mesh-writer"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });

  it("passes entries with non-reserved groups", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node", groups: ["research", "drafting"] }],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });

  it("passes entries with valid literal wiring refs", () => {
    const { errors } = validateInitialMesh(
      [
        {
          recipe: "mesh-node",
          escalatesTo: "authority",
          submitsWorkTo: "authority",
          messagesWith: ["authority", "peer-a"],
          acceptsWorkFrom: ["authority"],
        },
      ],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });

  it("passes entries with valid @-ref wiring fields", () => {
    const { errors } = validateInitialMesh(
      [
        {
          recipe: "mesh-node",
          escalatesTo: "@supervisors",
          messagesWith: ["@workers"],
        },
      ],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });

  it("returns empty errors for empty entries array", () => {
    const { errors } = validateInitialMesh([], ["mesh-node"], recipeAlwaysExists);
    expect(errors).toHaveLength(0);
  });
});

// ── Rule 1: recipe in spawns allowlist ───────────────────────────────────────

describe("validateInitialMesh — Rule 1: recipe allowlist", () => {
  it("emits error when recipe not in spawns", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-editor" }],
      ["mesh-node", "mesh-writer"],
      recipeAlwaysExists,
    );
    expect(errors.some((e) => /mesh-editor.*not in spawns/.test(e) || /not in spawns.*allowlist/.test(e))).toBe(true);
  });

  it("emits error for each recipe not in spawns", () => {
    const { errors } = validateInitialMesh(
      [
        { recipe: "a" },
        { recipe: "b" },
      ],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("passes when recipe is exactly in spawns", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node" }],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });

  it("shows the spawns allowlist in the error message", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "ghost" }],
      ["mesh-node", "mesh-writer"],
      recipeAlwaysExists,
    );
    expect(errors.some((e) => /mesh-node/.test(e) && /mesh-writer/.test(e))).toBe(true);
  });
});

// ── Rule 2: recipe file must exist ───────────────────────────────────────────

describe("validateInitialMesh — Rule 2: recipe file exists", () => {
  it("emits error when recipe file not found", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node" }],
      ["mesh-node"],
      recipeNeverExists,
    );
    expect(errors.some((e) => /not found/.test(e) || /recipe file/.test(e))).toBe(true);
  });

  it("passes when recipe file is found", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node" }],
      ["mesh-node"],
      (r) => r === "mesh-node",
    );
    expect(errors).toHaveLength(0);
  });
});

// ── Rule 3: no duplicate explicit names ──────────────────────────────────────

describe("validateInitialMesh — Rule 3: duplicate names", () => {
  it("emits error for duplicate explicit names", () => {
    const { errors } = validateInitialMesh(
      [
        { recipe: "mesh-node", name: "analyst" },
        { recipe: "mesh-node", name: "analyst" },
      ],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors.some((e) => /duplicate.*analyst|analyst.*duplicate/.test(e))).toBe(true);
  });

  it("allows same recipe with different names", () => {
    const { errors } = validateInitialMesh(
      [
        { recipe: "mesh-node", name: "analyst-1" },
        { recipe: "mesh-node", name: "analyst-2" },
      ],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });

  it("allows entries without names alongside named entries", () => {
    const { errors } = validateInitialMesh(
      [
        { recipe: "mesh-node", name: "analyst" },
        { recipe: "mesh-node" }, // unnamed — OK
      ],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });
});

// ── Rule 4: groups validation ─────────────────────────────────────────────────

describe("validateInitialMesh — Rule 4: groups", () => {
  it("emits error for group name starting with '_'", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node", groups: ["_internal"] }],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors.some((e) => /_internal/.test(e) && /reserved/.test(e))).toBe(true);
  });

  it("emits error for empty string group name", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node", groups: [""] }],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors.some((e) => /non-empty/.test(e))).toBe(true);
  });

  it("passes with non-reserved group names", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node", groups: ["research", "alpha"] }],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });
});

// ── Rule 5: @-ref fields parse correctly ─────────────────────────────────────

describe("validateInitialMesh — Rule 5: @-ref parsing", () => {
  it("emits error for malformed @ ref in escalatesTo", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node", escalatesTo: "@" }],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors.some((e) => /escalatesTo/.test(e))).toBe(true);
  });

  it("emits error for malformed @ ref in messagesWith array", () => {
    const { errors } = validateInitialMesh(
      [{ recipe: "mesh-node", messagesWith: ["@"] }],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors.some((e) => /messagesWith/.test(e))).toBe(true);
  });

  it("passes for valid @-ref formats", () => {
    const { errors } = validateInitialMesh(
      [
        {
          recipe: "mesh-node",
          escalatesTo: "@supervisors",
          submitsWorkTo: "@leads",
          messagesWith: ["@workers", "@$myGroups"],
          acceptsWorkFrom: ["@$myGroups:mesh-node"],
        },
      ],
      ["mesh-node"],
      recipeAlwaysExists,
    );
    expect(errors).toHaveLength(0);
  });
});

// ── Full error matrix ─────────────────────────────────────────────────────────

describe("validateInitialMesh — error matrix", () => {
  it("collects all errors from multiple failing entries", () => {
    const { errors } = validateInitialMesh(
      [
        { recipe: "bad-recipe", name: "dup", groups: ["_reserved"] },
        { recipe: "mesh-node", name: "dup" }, // duplicate name
      ],
      ["mesh-node"],
      recipeNeverExists,
    );
    // Should have: allowlist error, file-not-found error, reserved-group error, duplicate-name error, + mesh-node file-not-found
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
