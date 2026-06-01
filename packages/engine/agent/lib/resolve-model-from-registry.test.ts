// resolve-model-from-registry.test.ts — hermetic unit tests for the
// OpenRouter-aware registry resolver.
// No model calls, no network, no env-var pollution.

import { describe, it, expect } from "vitest";
import { resolveModelFromRegistry } from "./resolve-model-from-registry.js";
import type { RegistryLike } from "./resolve-model-from-registry.js";

// ── Minimal fixture models (cast to satisfy Model<Api>) ──────────────────────

type FakeModel = { provider: string; id: string };

const FIXTURES: FakeModel[] = [
  { provider: "openrouter", id: "deepseek/deepseek-v3.2" },
  { provider: "openrouter", id: "google/gemini-2.5-flash-lite" },
  { provider: "google", id: "gemini-2.5-flash-lite" },
  { provider: "anthropic", id: "claude-sonnet-4" },
];

// ── Fake RegistryLike backed by the fixture list ──────────────────────────────

function makeRegistry(models: FakeModel[]): RegistryLike {
  return {
    find(provider, modelId) {
      const found = models.find(
        (m) => m.provider === provider && m.id === modelId,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return found as any;
    },
    getAll() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return models as any[];
    },
  };
}

const reg = makeRegistry(FIXTURES);

// ── Test cases ────────────────────────────────────────────────────────────────

describe("resolveModelFromRegistry — OpenRouter slug (id contains '/')", () => {
  it("case 1: resolves deepseek/deepseek-v3.2 under openrouter active provider (bug regression)", () => {
    const result = resolveModelFromRegistry(reg, "deepseek/deepseek-v3.2", "openrouter");
    // Must return the openrouter entry, not split on '/' and fail.
    expect(result).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).provider).toBe("openrouter");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).id).toBe("deepseek/deepseek-v3.2");
  });

  it("case 2: resolves google/gemini-2.5-flash-lite to openrouter entry (not google-native) when active provider is openrouter", () => {
    const result = resolveModelFromRegistry(reg, "google/gemini-2.5-flash-lite", "openrouter");
    expect(result).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).provider).toBe("openrouter");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).id).toBe("google/gemini-2.5-flash-lite");
  });
});

describe("resolveModelFromRegistry — split path (genuine provider/id)", () => {
  it("case 3: anthropic/claude-sonnet-4 with undefined active provider resolves via split path", () => {
    const result = resolveModelFromRegistry(reg, "anthropic/claude-sonnet-4", undefined);
    expect(result).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).provider).toBe("anthropic");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).id).toBe("claude-sonnet-4");
  });

  it("case 4: anthropic/claude-sonnet-4 still resolves when active provider is openrouter (step1 miss, step2 hit — backward-compat)", () => {
    // activeProvider=openrouter → find(openrouter, "anthropic/claude-sonnet-4") → undefined
    // then split → find(anthropic, "claude-sonnet-4") → hit
    const result = resolveModelFromRegistry(reg, "anthropic/claude-sonnet-4", "openrouter");
    expect(result).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).provider).toBe("anthropic");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).id).toBe("claude-sonnet-4");
  });
});

describe("resolveModelFromRegistry — no-slash getAll path", () => {
  it("case 5a: gemini-2.5-flash-lite with active provider google resolves google-native entry", () => {
    const result = resolveModelFromRegistry(reg, "gemini-2.5-flash-lite", "google");
    expect(result).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).provider).toBe("google");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).id).toBe("gemini-2.5-flash-lite");
  });

  it("case 5b: gemini-2.5-flash-lite with undefined active provider finds the entry via getAll id-scan", () => {
    // No slash, activeProvider=undefined → skip step1 → skip step2 → getAll scan by id
    const result = resolveModelFromRegistry(reg, "gemini-2.5-flash-lite", undefined);
    expect(result).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).id).toBe("gemini-2.5-flash-lite");
  });
});

describe("resolveModelFromRegistry — nonexistent id", () => {
  it("case 6: nonexistent model id returns undefined", () => {
    const result = resolveModelFromRegistry(reg, "no-such-provider/no-such-model", "openrouter");
    expect(result).toBeUndefined();
  });

  it("returns undefined for a completely unknown id with no active provider", () => {
    const result = resolveModelFromRegistry(reg, "totally-unknown", undefined);
    expect(result).toBeUndefined();
  });
});
