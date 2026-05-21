// resolve-model.test.ts — hermetic unit tests for the tier resolver.
// No model calls, no network, no env-var pollution from models.env.

import { describe, it, expect } from "vitest";
import { resolveModel } from "./resolve-model.js";

const BUNDLED: Record<string, string> = {
  RABBIT_SAGE_MODEL: "bundled/sage-model",
  LEAD_HARE_MODEL: "bundled/hare-model",
  TASK_RABBIT_MODEL: "bundled/rabbit-model",
};

const OVERRIDE: Record<string, string> = {
  RABBIT_SAGE_MODEL: "override/sage-model",
  LEAD_HARE_MODEL: "override/hare-model",
  TASK_RABBIT_MODEL: "override/rabbit-model",
};

describe("resolveModel — literal passthrough", () => {
  it("passes through a literal model ID unchanged", () => {
    expect(resolveModel("deepseek/deepseek-v3.2", {}, {}, BUNDLED)).toBe(
      "deepseek/deepseek-v3.2",
    );
  });

  it("passes through a provider/model ID with multiple slashes", () => {
    expect(
      resolveModel("openrouter/google/gemini-flash", {}, {}, BUNDLED),
    ).toBe("openrouter/google/gemini-flash");
  });

  it("does NOT treat a non-tier-var all-caps string as a tier var", () => {
    // e.g., a user's own env var name that happens to be all caps
    expect(
      resolveModel("SOME_OTHER_VAR", { SOME_OTHER_VAR: "foo" }, {}, BUNDLED),
    ).toBe("SOME_OTHER_VAR");
  });
});

describe("resolveModel — env var hit (highest precedence)", () => {
  it("resolves TASK_RABBIT_MODEL from the injected env", () => {
    const env = { TASK_RABBIT_MODEL: "anthropic/claude-haiku-4" };
    expect(resolveModel("TASK_RABBIT_MODEL", env, OVERRIDE, BUNDLED)).toBe(
      "anthropic/claude-haiku-4",
    );
  });

  it("resolves LEAD_HARE_MODEL from injected env", () => {
    const env = { LEAD_HARE_MODEL: "anthropic/claude-sonnet-4-5" };
    expect(resolveModel("LEAD_HARE_MODEL", env, OVERRIDE, BUNDLED)).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("resolves RABBIT_SAGE_MODEL from injected env", () => {
    const env = { RABBIT_SAGE_MODEL: "anthropic/claude-opus-4" };
    expect(resolveModel("RABBIT_SAGE_MODEL", env, OVERRIDE, BUNDLED)).toBe(
      "anthropic/claude-opus-4",
    );
  });

  it("env var wins over override and bundled (precedence: env > override > bundled)", () => {
    const env = { TASK_RABBIT_MODEL: "env/model" };
    expect(resolveModel("TASK_RABBIT_MODEL", env, OVERRIDE, BUNDLED)).toBe(
      "env/model",
    );
  });
});

describe("resolveModel — override file hit (falls through when env unset)", () => {
  it("resolves from override when env var is unset", () => {
    expect(
      resolveModel("TASK_RABBIT_MODEL", {}, OVERRIDE, BUNDLED),
    ).toBe("override/rabbit-model");
  });

  it("resolves from override when env var is set but empty", () => {
    const env = { TASK_RABBIT_MODEL: "" };
    expect(
      resolveModel("TASK_RABBIT_MODEL", env, OVERRIDE, BUNDLED),
    ).toBe("override/rabbit-model");
  });

  it("override wins over bundled (precedence: override > bundled)", () => {
    const partialOverride = { TASK_RABBIT_MODEL: "override/rabbit-model" };
    expect(
      resolveModel("TASK_RABBIT_MODEL", {}, partialOverride, BUNDLED),
    ).toBe("override/rabbit-model");
  });
});

describe("resolveModel — bundled default hit (falls through when env+override unset)", () => {
  it("resolves from bundled when env and override are both missing the tier", () => {
    expect(resolveModel("TASK_RABBIT_MODEL", {}, {}, BUNDLED)).toBe(
      "bundled/rabbit-model",
    );
  });

  it("resolves RABBIT_SAGE_MODEL from bundled defaults", () => {
    expect(resolveModel("RABBIT_SAGE_MODEL", {}, {}, BUNDLED)).toBe(
      "bundled/sage-model",
    );
  });

  it("resolves LEAD_HARE_MODEL from bundled defaults", () => {
    expect(resolveModel("LEAD_HARE_MODEL", {}, {}, BUNDLED)).toBe(
      "bundled/hare-model",
    );
  });
});

describe("resolveModel — unresolvable tier throws", () => {
  it("throws when a tier var has no env, no override, no bundled entry", () => {
    expect(() =>
      resolveModel("TASK_RABBIT_MODEL", {}, {}, {}),
    ).toThrow(/TASK_RABBIT_MODEL/);
  });

  it("throws with a message mentioning the missing tier name", () => {
    expect(() =>
      resolveModel("LEAD_HARE_MODEL", {}, {}, {}),
    ).toThrow(/LEAD_HARE_MODEL/);
  });

  it("error message says 'unresolvable'", () => {
    expect(() =>
      resolveModel("RABBIT_SAGE_MODEL", {}, {}, {}),
    ).toThrow(/unresolvable/i);
  });
});
