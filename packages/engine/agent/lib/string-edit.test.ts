// Tests for the shared applyUnique helper in _lib/string-edit.ts

import { describe, it, expect } from "vitest";
import { applyUnique } from "./string-edit";

describe("applyUnique", () => {
  it("returns error when oldString is empty", () => {
    const r = applyUnique("some content", "", "new");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toMatch(/empty/i);
  });

  it("returns error when oldString is not found in content", () => {
    const r = applyUnique("hello world", "foobar", "baz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toMatch(/not found/i);
  });

  it("returns error when oldString matches multiple times", () => {
    const r = applyUnique("aaa bbb aaa", "aaa", "xxx");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toMatch(/multiple/i);
  });

  it("returns the spliced output for a single match", () => {
    const r = applyUnique("hello world", "world", "earth");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out).toBe("hello earth");
  });

  it("replaces at the start of content", () => {
    const r = applyUnique("start middle end", "start", "BEGIN");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out).toBe("BEGIN middle end");
  });

  it("replaces at the end of content", () => {
    const r = applyUnique("start middle end", "end", "FINISH");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out).toBe("start middle FINISH");
  });

  it("replaces the entire content when oldString equals content", () => {
    const r = applyUnique("whole", "whole", "replaced");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out).toBe("replaced");
  });

  it("allows newString to be empty (effectively deletes oldString)", () => {
    const r = applyUnique("foo BAR baz", "BAR", "");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out).toBe("foo  baz");
  });

  it("handles multi-line content correctly", () => {
    const content = "line 1\nline 2\nline 3\n";
    const r = applyUnique(content, "line 2\n", "replaced\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out).toBe("line 1\nreplaced\nline 3\n");
  });

  it("does NOT treat overlapping occurrences as two separate matches", () => {
    // "aa" appears twice in "aaa" via overlap — but indexOf won't find that;
    // it finds positions 0 and 1 non-overlapping for "aa" in "aaaa".
    const r = applyUnique("aaaa", "aa", "bb");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toMatch(/multiple/i);
  });
});
