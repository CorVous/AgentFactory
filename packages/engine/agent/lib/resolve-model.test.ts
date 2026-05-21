// resolve-model.test.ts — hermetic unit tests for the tier resolver.
// No model calls, no network, no env-var pollution from models.env.

import { describe, it, expect } from "vitest";
import { resolveModel } from "./resolve-model.js";

describe("resolveModel", () => {
  it("passes through a literal model ID unchanged", () => {
    expect(resolveModel("deepseek/deepseek-v3.2", {})).toBe("deepseek/deepseek-v3.2");
  });

  it("passes through a provider/model ID with slashes", () => {
    expect(resolveModel("openrouter/google/gemini-flash", {})).toBe(
      "openrouter/google/gemini-flash"
    );
  });

  it("resolves a known tier var from the injected env", () => {
    const env = { TASK_RABBIT_MODEL: "anthropic/claude-haiku-4" };
    expect(resolveModel("TASK_RABBIT_MODEL", env)).toBe("anthropic/claude-haiku-4");
  });

  it("resolves LEAD_HARE_MODEL from injected env", () => {
    const env = { LEAD_HARE_MODEL: "anthropic/claude-sonnet-4-5" };
    expect(resolveModel("LEAD_HARE_MODEL", env)).toBe("anthropic/claude-sonnet-4-5");
  });

  it("resolves RABBIT_SAGE_MODEL from injected env", () => {
    const env = { RABBIT_SAGE_MODEL: "anthropic/claude-opus-4" };
    expect(resolveModel("RABBIT_SAGE_MODEL", env)).toBe("anthropic/claude-opus-4");
  });

  it("throws when a tier var is present but not set in env", () => {
    expect(() => resolveModel("TASK_RABBIT_MODEL", {})).toThrow(
      /TASK_RABBIT_MODEL/
    );
  });

  it("throws with a message mentioning the missing var name", () => {
    expect(() => resolveModel("LEAD_HARE_MODEL", {})).toThrow(
      /LEAD_HARE_MODEL/
    );
  });

  it("does NOT treat a non-tier-var all-caps string as a tier var", () => {
    // e.g., a user's own env var name that happens to be all caps
    expect(resolveModel("SOME_OTHER_VAR", { SOME_OTHER_VAR: "foo" })).toBe("SOME_OTHER_VAR");
  });
});
